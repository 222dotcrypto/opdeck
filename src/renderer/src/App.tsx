import { useEffect, useState } from 'react'
import { useStore } from './store'
import { isTauri } from './tauri-bridge'
import Titlebar from './components/Titlebar'
import Sidebar from './components/Sidebar'
import WorkspaceArea from './components/WorkspaceArea'
import Overview from './components/Overview'
import Review from './components/Review'
import Settings from './components/Settings'
import NewWorkspaceModal from './components/NewWorkspaceModal'
import Toasts from './components/Toasts'

export default function App(): JSX.Element {
  const loaded = useStore((s) => s.loaded)
  const init = useStore((s) => s.init)
  const tab = useStore((s) => s.tab)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const [showNew, setShowNew] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const openNew = (groupName = ''): void => {
    setNewGroupName(groupName)
    setShowNew(true)
  }

  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    init()
  }, [init])

  // Полноэкранный режим (под Tauri): сдвигаем название/вкладки влево.
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    ;(async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const w = getCurrentWindow()
        const update = (): void => {
          w.isFullscreen().then(setFullscreen).catch(() => {})
        }
        update()
        unlisten = await w.onResized(update)
      } catch {
        /* нет среды Tauri */
      }
    })()
    return () => unlisten?.()
  }, [])

  // Перетаскивание файла/картинки в окно-терминал → вписываем ПУТЬ в сессию под курсором.
  // HTML-drop в WKWebView перехватывает Tauri, поэтому слушаем его событие (даёт реальные пути).
  useEffect(() => {
    if (!isTauri()) return
    let un: (() => void) | undefined
    ;(async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview')
        un = await getCurrentWebview().onDragDropEvent((e) => {
          if (e.payload.type !== 'drop') return
          const paths = e.payload.paths
          if (!paths || paths.length === 0) return
          const dpr = window.devicePixelRatio || 1
          const x = e.payload.position.x / dpr
          const y = e.payload.position.y / dpr
          const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('.pane')
          // окно под курсором; если бросили мимо — вписываем в активную сессию
          const sid =
            el?.getAttribute('data-session-id') || useStore.getState().focusedSessionId
          if (!sid) return
          const quoted = paths.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(' ')
          window.api.pty.write(sid, quoted + ' ')
        })
      } catch {
        /* нет среды Tauri */
      }
    })()
    return () => un?.()
  }, [])

  // Горячие клавиши
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        openNew()
      } else if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1
        const ws = useStore.getState().workspaces[idx]
        if (ws) useStore.getState().setActiveWorkspace(ws.id)
      } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'u') {
        // прыжок к последней работающей/ждущей сессии
        const st = useStore.getState()
        const target = [...st.sessions].reverse().find((s) => ['working', 'awaiting'].includes(s.status))
        if (target) {
          st.setActiveWorkspace(target.workspaceId)
          st.setFocused(target.id)
          st.setTab('workspace')
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!loaded) {
    return <div className="loading">Deck загружается…</div>
  }

  return (
    <div className={`app ${fullscreen ? 'fullscreen' : ''}`}>
      <Titlebar />
      <div className="body">
        {/* сайдбар — фикс-ширина с плавным сворачиванием в обе стороны (CSS-переход ширины) */}
        <div className={`sidebar-shell ${sidebarCollapsed ? 'collapsed' : ''}`}>
          <Sidebar onNew={openNew} />
        </div>
        <main className="main">
          {tab === 'overview' ? (
            <Overview onNew={openNew} />
          ) : tab === 'review' ? (
            <Review />
          ) : tab === 'settings' ? (
            <Settings />
          ) : (
            <WorkspaceArea />
          )}
        </main>
      </div>
      <Toasts />
      {showNew && (
        <NewWorkspaceModal defaultGroupName={newGroupName} onClose={() => setShowNew(false)} />
      )}
    </div>
  )
}
