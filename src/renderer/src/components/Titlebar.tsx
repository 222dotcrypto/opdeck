import { useStore } from '../store'
import CliLimits from './CliLimits'
import ShortcutsModal from './ShortcutsModal'

// Нативный светофор macOS (закрыть/свернуть/во весь экран) слева — даёт titleBarStyle:Overlay.
// Здесь вкладки + зона перетаскивания окна + кнопки сворачивания панелей справа.
export default function Titlebar(): JSX.Element {
  const tab = useStore((s) => s.tab)
  const setTab = useStore((s) => s.setTab)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const rightPanelVisible = useStore((s) => s.rightPanelVisible)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const toggleRightPanel = useStore((s) => s.toggleRightPanel)
  const setShortcutsOpen = useStore((s) => s.setShortcutsOpen)
  const shortcutsOpen = useStore((s) => s.shortcutsOpen)

  // переключатель правой панели имеет смысл только в воркспейсе с открытым воркспейсом
  const canToggleRight = tab === 'workspace' && !!activeWorkspaceId

  return (
    <div className="titlebar" data-tauri-drag-region>
      <button
        className={`tb-btn tb-btn-left ${sidebarCollapsed ? '' : 'on'}`}
        title={sidebarCollapsed ? 'Показать список воркспейсов' : 'Скрыть список воркспейсов'}
        onClick={toggleSidebar}
      >
        ◧
      </button>
      <div className="tb-tabs">
        <button className={tab === 'workspace' ? 'active' : ''} onClick={() => setTab('workspace')}>
          Воркспейс
        </button>
        <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>
          Сводка
        </button>
        <button className={tab === 'review' ? 'active' : ''} onClick={() => setTab('review')}>
          Ревью
        </button>
        <button className={tab === 'backlog' ? 'active' : ''} onClick={() => setTab('backlog')}>
          Задачи
        </button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          Настройки
        </button>
      </div>
      <CliLimits />
      <div className="tb-keys-wrap">
        <button
          className={`tb-btn tb-keys ${shortcutsOpen ? 'on' : ''}`}
          title="Все горячие клавиши (⌘/Ctrl + /)"
          onClick={() => setShortcutsOpen(!shortcutsOpen)}
        >
          ⓘ
        </button>
        {shortcutsOpen && <ShortcutsModal />}
      </div>
      {canToggleRight && (
        <div className="tb-right">
          <button
            className={`tb-btn ${rightPanelVisible ? 'on' : ''}`}
            title={rightPanelVisible ? 'Скрыть файлы' : 'Показать файлы'}
            onClick={toggleRightPanel}
          >
            ◨
          </button>
        </div>
      )}
    </div>
  )
}
