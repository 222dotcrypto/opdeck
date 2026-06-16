import { useStore } from '../store'
import CliLimits from './CliLimits'

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
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          Настройки
        </button>
      </div>
      <CliLimits />
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
