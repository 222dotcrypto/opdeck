import { useEffect, useState } from 'react'

// RFC 0011 A1: мягкая подсказка, когда папка воркспейса слишком большая и БЕЗ git.
// На такой громадине снимок-diff («было») ненадёжен — может показывать «было==стало»
// (пустой diff). Предлагаем открыть конкретный проект или git-репозиторий.
// Это не ошибка — подсказка, закрывается крестиком; снова появится при смене папки.
export default function DiffFolderHint({ folder }: { folder: string }): JSX.Element | null {
  const [oversized, setOversized] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    // при смене папки сбрасываем и перепроверяем
    setDismissed(false)
    setOversized(false)
    if (!folder) return
    let alive = true
    window.api.git
      .diffFolderOversized(folder)
      .then((v) => {
        if (alive) setOversized(v)
      })
      .catch(() => {
        /* нет ядра (браузер без Tauri) — молча пропускаем */
      })
    return () => {
      alive = false
    }
  }, [folder])

  if (!oversized || dismissed) return null

  return (
    <div className="diff-hint">
      <span className="diff-hint-text">Папка большая — открой проект</span>
      <button className="diff-hint-x" title="Скрыть" onClick={() => setDismissed(true)}>
        ✕
      </button>
    </div>
  )
}
