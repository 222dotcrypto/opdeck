import { useState } from 'react'
import { useStore } from '../store'

// RFC 0013 — перенос правок агента (merge-back) в основное дерево.
// Бар виден ТОЛЬКО когда в фокусе сессия-клон (своя ветка: cloneOf+branch, cwd≠папке
// воркспейса). Кнопка открывает модалку выбора файлов (галочки) + подтверждение; ядро
// делает резервную точку и при конфликте основное не трогает. После переноса — «Откатить».
export default function MergeControls(): JSX.Element | null {
  const sessions = useStore((s) => s.sessions)
  const focusedId = useStore((s) => s.focusedSessionId)
  const activeWsId = useStore((s) => s.activeWorkspaceId)
  const workspaces = useStore((s) => s.workspaces)
  const changedFiles = useStore((s) => s.changedFiles)
  const lastMerge = useStore((s) => s.lastMerge)
  const applyMerge = useStore((s) => s.applyMerge)
  const undoMerge = useStore((s) => s.undoMerge)

  const ws = workspaces.find((w) => w.id === activeWsId)
  const focused = sessions.find((s) => s.id === focusedId)
  const isClone = !!(focused && ws && focused.cloneOf && focused.branch && focused.cwd !== ws.folder)
  const files = (activeWsId && changedFiles[activeWsId]) || []

  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState<Record<string, boolean>>({})

  // бар не нужен, если это не клон-сессия (у обычной нет «своей ветки» для переноса)
  if (!isClone) return null

  const openModal = (): void => {
    const all: Record<string, boolean> = {}
    files.forEach((f) => (all[f.path] = true))
    setSel(all)
    setOpen(true)
  }
  const chosen = files.filter((f) => sel[f.path]).map((f) => f.path)
  const doApply = async (): Promise<void> => {
    setOpen(false)
    await applyMerge(chosen)
  }

  return (
    <div className="merge-bar">
      <button
        className="merge-apply-btn"
        disabled={files.length === 0}
        title="Перенести выбранные правки агента в основную папку проекта (main)"
        onClick={openModal}
      >
        ⤳ Перенести в main{files.length ? ` (${files.length})` : ''}
      </button>
      {lastMerge && (
        <button
          className="merge-undo-btn"
          title="Вернуть основную папку к состоянию до переноса"
          onClick={() => undoMerge()}
        >
          ↩ Откатить ({lastMerge.files})
        </button>
      )}

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal merge-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Перенести правки агента в main</h3>
            <p className="merge-note">
              Возьму отмеченные файлы из ветки агента и положу в main (основную папку проекта).
              Сделаю резервную точку — вернуть всё можно кнопкой «Откатить». Если файл уже есть
              в main или разошёлся — не трогаю, скажу об этом.
            </p>
            <div className="merge-file-list">
              {files.map((f) => (
                <label key={f.path} className="merge-file-row">
                  <input
                    type="checkbox"
                    checked={!!sel[f.path]}
                    onChange={(e) => setSel((p) => ({ ...p, [f.path]: e.target.checked }))}
                  />
                  <span className={`merge-file-status st-${f.status}`}>
                    {f.status.charAt(0).toUpperCase()}
                  </span>
                  <span className="merge-file-path">{f.path}</span>
                </label>
              ))}
            </div>
            <div className="merge-modal-actions">
              <button className="ws-tb-btn" onClick={() => setOpen(false)}>
                Отмена
              </button>
              <button className="btn-primary" disabled={chosen.length === 0} onClick={doApply}>
                Применить ({chosen.length})
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
