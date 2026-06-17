import { useMemo, useState } from 'react'
import { useStore } from '../store'
import EditableName from './EditableName'
import Logo from './Logo'
import type { SessionStatus, Workspace } from '../../../shared/types'

function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~')
}

// Цель переноса: id группы, либо 'ungrouped' (без группы), либо null (мимо).
type DropTarget = string | 'ungrouped' | null

export default function Sidebar({ onNew }: { onNew: (groupName?: string) => void }): JSX.Element {
  const groups = useStore((s) => s.groups)
  const workspaces = useStore((s) => s.workspaces)
  const sessions = useStore((s) => s.sessions)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace)
  const toggleGroup = useStore((s) => s.toggleGroup)
  const deleteWorkspace = useStore((s) => s.deleteWorkspace)
  const deleteGroup = useStore((s) => s.deleteGroup)
  const renameWorkspace = useStore((s) => s.renameWorkspace)
  const renameGroup = useStore((s) => s.renameGroup)
  const moveWorkspaceToGroup = useStore((s) => s.moveWorkspaceToGroup)

  // Перетаскивание воркспейса между группами (ручное, мышью).
  const [draggingWsId, setDraggingWsId] = useState<string | undefined>()
  const [dragOverGroup, setDragOverGroup] = useState<DropTarget>(null)
  // Подтверждение закрытия (своя модалка — нативный confirm() в WKWebView ненадёжен).
  const [confirmAction, setConfirmAction] = useState<{ msg: string; onYes: () => void } | null>(null)

  const ungrouped = workspaces.filter((w) => !w.groupId)

  // Карта «id сессии → статус» строится ОДИН раз за рендер (а не .find() по всему
  // массиву на каждую сессию каждого воркспейса). Зависит только от sessions —
  // смена статуса одной сессии пересоздаёт массив и карту, и это правильно:
  // счётчики обязаны обновиться. Но тяжёлый O(сессии×воркспейсы) поиск ушёл.
  const statusById = useMemo(() => {
    const m = new Map<string, SessionStatus>()
    sessions.forEach((s) => m.set(s.id, s.status))
    return m
  }, [sessions])

  // Счётчики по статусам на воркспейс. Пересчитываются только когда меняется
  // карта статусов или состав сессий воркспейса. Ключ — id воркспейса.
  const countsByWs = useMemo(() => {
    const m = new Map<string, { working: number; awaiting: number; done: number }>()
    workspaces.forEach((w) => {
      let working = 0
      let awaiting = 0
      let done = 0
      w.sessionIds.forEach((id) => {
        // жёлтый — ждёт, синий — работает, зелёный — закончила. «idle» не показываем.
        const st = statusById.get(id)
        if (st === 'working') working++
        else if (st === 'awaiting') awaiting++
        else if (st === 'ready') done++
      })
      m.set(w.id, { working, awaiting, done })
    })
    return m
  }, [workspaces, statusById])

  const startWsDrag = (e: React.MouseEvent, w: Workspace): void => {
    if (e.button !== 0) return
    // нажатие на крестик удаления — не перетаскивание
    if ((e.target as HTMLElement).closest('.sb-ws-del')) return
    const sx = e.clientX
    const sy = e.clientY
    let dragging = false

    const groupAt = (x: number, y: number): DropTarget => {
      const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('[data-drop-group]')
      const g = el?.getAttribute('data-drop-group')
      return g === undefined || g === null ? null : (g as DropTarget)
    }

    const onMove = (ev: MouseEvent): void => {
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) {
        dragging = true
        setDraggingWsId(w.id)
        document.body.style.cursor = 'grabbing'
      }
      if (dragging) setDragOverGroup(groupAt(ev.clientX, ev.clientY))
    }
    const onUp = (ev: MouseEvent): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      if (dragging) {
        const g = groupAt(ev.clientX, ev.clientY)
        if (g !== null) {
          const target = g === 'ungrouped' ? undefined : g
          if (target !== w.groupId) moveWorkspaceToGroup(w.id, target)
        }
      } else {
        // не таскали — это клик: открыть воркспейс
        setActiveWorkspace(w.id)
      }
      setDraggingWsId(undefined)
      setDragOverGroup(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const renderWs = (w: Workspace): JSX.Element => {
    // счётчики уже посчитаны в countsByWs (мемоизированы) — здесь только читаем.
    const { working, awaiting, done } = countsByWs.get(w.id) ?? {
      working: 0,
      awaiting: 0,
      done: 0
    }
    return (
      <div
        key={w.id}
        className={`sb-ws ${w.id === activeWorkspaceId ? 'active' : ''} ${draggingWsId === w.id ? 'ws-dragging' : ''}`}
        onMouseDown={(e) => startWsDrag(e, w)}
        title={`${w.folder}\n(перетащи в группу, чтобы переместить)`}
      >
        <div className="sb-ws-main">
          <EditableName
            className="sb-ws-name"
            value={w.name}
            onCommit={(v) => renameWorkspace(w.id, v)}
          />
          <span className="sb-ws-path">{shortPath(w.folder)}</span>
        </div>
        {(awaiting > 0 || working > 0 || done > 0) && (
          <span className="sb-counts">
            {awaiting > 0 && <span className="sb-cnt awaiting" title="ждут ответа">{awaiting}</span>}
            {working > 0 && <span className="sb-cnt working" title="в работе">{working}</span>}
            {done > 0 && <span className="sb-cnt ready" title="закончили">{done}</span>}
          </span>
        )}
        <button
          className="sb-ws-del"
          title="Удалить воркспейс"
          onClick={(e) => {
            e.stopPropagation()
            setConfirmAction({
              msg: `Закрыть воркспейс «${w.name}»? Его сессии будут закрыты.`,
              onYes: () => deleteWorkspace(w.id)
            })
          }}
        >
          ✕
        </button>
      </div>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sb-header">
        <span>WORKSPACES</span>
        <button className="sb-add" title="Новый воркспейс" onClick={() => onNew('')}>
          ＋
        </button>
      </div>
      <div className="sb-scroll">
        {groups.map((g) => {
          const wss = workspaces.filter((w) => w.groupId === g.id)
          return (
            <div
              key={g.id}
              className={`sb-group ${dragOverGroup === g.id && draggingWsId ? 'drop-into' : ''}`}
              data-drop-group={g.id}
            >
              <div className="sb-group-head" onClick={() => toggleGroup(g.id)}>
                <span className="sb-caret">{g.collapsed ? '▸' : '▾'}</span>
                <EditableName
                  className="sb-group-name"
                  value={g.name}
                  onCommit={(v) => renameGroup(g.id, v)}
                />
                <span className="sb-group-count">{wss.length}</span>
                <button
                  className="sb-add"
                  title={`Новый воркспейс в группе «${g.name}»`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onNew(g.name)
                  }}
                >
                  ＋
                </button>
                <button
                  className="sb-group-del"
                  title={`Удалить группу «${g.name}»`}
                  onClick={(e) => {
                    e.stopPropagation()
                    const msg =
                      wss.length > 0
                        ? `Закрыть группу «${g.name}»? Воркспейсы не удалятся — переедут в «Без группы».`
                        : `Закрыть пустую группу «${g.name}»?`
                    setConfirmAction({ msg, onYes: () => deleteGroup(g.id) })
                  }}
                >
                  ✕
                </button>
              </div>
              {!g.collapsed && wss.map(renderWs)}
              {/* зона сброса в свёрнутую/пустую группу при перетаскивании */}
              {draggingWsId && (g.collapsed || wss.length === 0) && (
                <div className="sb-drop-hint">бросить сюда</div>
              )}
            </div>
          )
        })}

        {(ungrouped.length > 0 || draggingWsId) && (
          <div
            className={`sb-group ${dragOverGroup === 'ungrouped' && draggingWsId ? 'drop-into' : ''}`}
            data-drop-group="ungrouped"
          >
            <div className="sb-group-head plain">
              <span className="sb-group-name muted">UNGROUPED</span>
              <button className="sb-add" title="Новый воркспейс без группы" onClick={() => onNew('')}>
                ＋
              </button>
            </div>
            {ungrouped.map(renderWs)}
            {draggingWsId && ungrouped.length === 0 && (
              <div className="sb-drop-hint">бросить сюда — убрать из группы</div>
            )}
          </div>
        )}

        {workspaces.length === 0 && (
          <div className="sb-empty">Нет воркспейсов.<br />Нажми ＋ сверху, чтобы создать.</div>
        )}
      </div>
      <div className="sb-footer">
        <Logo size={16} />
        <span className="sb-footer-name">opdeck</span>
        <span className="sb-footer-ver">v0.1.0</span>
      </div>

      {confirmAction && (
        <div className="modal-backdrop" onClick={() => setConfirmAction(null)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-msg">{confirmAction.msg}</p>
            <div className="confirm-actions">
              <button className="ws-tb-btn" onClick={() => setConfirmAction(null)}>
                Нет
              </button>
              <button
                className="btn-danger"
                onClick={() => {
                  confirmAction.onYes()
                  setConfirmAction(null)
                }}
              >
                Да, закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
