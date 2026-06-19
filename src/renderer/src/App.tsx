import { useEffect, useState } from 'react'
import { useStore } from './store'
import { isTauri } from './tauri-bridge'
import Titlebar from './components/Titlebar'
import Sidebar from './components/Sidebar'
import WorkspaceArea from './components/WorkspaceArea'
import Overview from './components/Overview'
import Review from './components/Review'
import Backlog from './components/Backlog'
import Settings from './components/Settings'
import NewWorkspaceModal from './components/NewWorkspaceModal'
import CommandPalette from './components/CommandPalette'
import Toasts from './components/Toasts'

export default function App(): JSX.Element {
  const loaded = useStore((s) => s.loaded)
  const init = useStore((s) => s.init)
  const tab = useStore((s) => s.tab)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  // RFC 0017 X1: командная палитра (Cmd+K / Ctrl+K)
  const commandPaletteOpen = useStore((s) => s.commandPaletteOpen)
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

  // Горячие клавиши.
  // Слушаем в фазе ПЕРЕХВАТА (capture, третий аргумент = true): окно видит нажатие ПЕРВЫМ,
  // раньше, чем фокус-терминал (xterm) успеет его «съесть». Это важно для Ctrl/Cmd+Shift+C:
  // без перехвата xterm проглатывал комбо до всплытия к window, и беклог не открывался.
  // ВАЖНО: перехватываем (preventDefault/stopImmediatePropagation) ТОЛЬКО на совпавших
  // комбо — для любых прочих клавиш ничего не делаем, чтобы ввод в терминал и Ctrl+C
  // (прерывание процесса) продолжали работать как обычно.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const k = e.key.toLowerCase()
      // RFC 0017 X1: командная палитра — Cmd+K (mac) ИЛИ Ctrl+K (Win/Linux). Перехватываем
      // в фазе capture (как Ctrl+Shift+C ниже), иначе фокус-терминал (xterm) проглотит комбо.
      // Тоггл: открыта → закрыть, закрыта → открыть. Читаем СВЕЖИЙ снимок флага из стора.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && k === 'k') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const st = useStore.getState()
        st.setCommandPaletteOpen(!st.commandPaletteOpen)
        return
      }
      // Cmd/Ctrl + «/» — окно всех горячих клавиш. Голую «?» не вешаем: она нужна для
      // ввода в терминал/промпт агента; модификатор «/» вводу не мешает.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && k === '/') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const st = useStore.getState()
        st.setShortcutsOpen(!st.shortcutsOpen)
        return
      }
      // RFC 0016: быстрый захват задачи — открыть вкладку «Задачи» и сфокусировать ввод.
      // Ctrl+Shift+C (Win/Linux) ИЛИ Cmd+Shift+C (mac). In-app, не глобальный OS-хоткей.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'c') {
        e.preventDefault()
        e.stopImmediatePropagation() // не даём фокус-терминалу перехватить комбо
        useStore.getState().setTab('backlog')
        // даём вкладке отрисоваться, затем фокусируем поле быстрого ввода задачи
        setTimeout(() => {
          document.getElementById('backlog-quick-input')?.focus()
        }, 0)
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && k === 'n') {
        // Новый воркспейс: Ctrl+N (Win/Linux) ИЛИ Cmd+N (mac).
        e.preventDefault()
        openNew()
      } else if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '9') {
        // Переключение воркспейса 1-9: Ctrl+цифра (Win/Linux) ИЛИ Cmd+цифра (mac).
        const idx = Number(e.key) - 1
        const ws = useStore.getState().workspaces[idx]
        if (ws) useStore.getState().setActiveWorkspace(ws.id)
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'u') {
        // Прыжок к активной сессии: Ctrl+Shift+U (Win/Linux) ИЛИ Cmd+Shift+U (mac).
        // прыжок к последней работающей/ждущей сессии
        const st = useStore.getState()
        const target = [...st.sessions].reverse().find((s) => ['working', 'awaiting'].includes(s.status))
        if (target) {
          st.setActiveWorkspace(target.workspaceId)
          st.setFocused(target.id)
          st.setTab('workspace')
        }
      }
      // прочие клавиши не трогаем — ни preventDefault, ни stop: терминал печатает свободно
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  if (!loaded) {
    return <div className="loading">opdeck загружается…</div>
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
          {/* WorkspaceArea держим ВСЕГДА смонтированной, прячем через display:none, когда вкладка
              ≠ воркспейс. Иначе переключение во вкладку размонтировало бы терминалы (term.dispose
              на каждую сессию = лаг ~1-2с при заходе в Настройки) и перезаливало 2МБ-буфер при
              возврате. safeFit в TerminalPane при нулевых размерах (display:none) НЕ трогает PTY
              → агентский TUI не сбивается; ResizeObserver сам перефитит при возврате. */}
          <div style={{ display: tab === 'workspace' ? 'contents' : 'none' }}>
            <WorkspaceArea />
          </div>
          {tab === 'overview' && <Overview onNew={openNew} />}
          {tab === 'review' && <Review />}
          {tab === 'backlog' && <Backlog />}
          {tab === 'settings' && <Settings />}
        </main>
      </div>
      <Toasts />
      {showNew && (
        <NewWorkspaceModal defaultGroupName={newGroupName} onClose={() => setShowNew(false)} />
      )}
      {/* RFC 0017 X1: командная палитра поверх всего; «Новый воркспейс» переиспользует openNew */}
      {commandPaletteOpen && <CommandPalette onNew={() => openNew()} />}
    </div>
  )
}
