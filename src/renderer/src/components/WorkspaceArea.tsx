import { memo, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { useStore, diffSourceFolder } from '../store'
import PanelGrid from './PanelGrid'
import FileTree from './FileTree'
import DiffFolderHint from './DiffFolderHint'
import MergeControls from './MergeControls'
import EditorPane from './EditorPane'
import AddSessionForm from './AddSessionForm'
import EditableName from './EditableName'
import LayoutThumb, { colsOfLayout } from './LayoutThumb'
import { LAYOUTS } from './layouts'
import SessionInspector from './SessionInspector'
import './WorkspaceArea.css'

function WorkspaceArea(): JSX.Element {
  const activeId = useStore((s) => s.activeWorkspaceId)
  const workspaces = useStore((s) => s.workspaces)
  const sessions = useStore((s) => s.sessions)
  const selectedFile = useStore((s) => s.selectedFile)
  const focusedId = useStore((s) => s.focusedSessionId)
  const setLayout = useStore((s) => s.setLayout)
  const showFiles = useStore((s) => s.rightPanelVisible)
  const setWorkspaceFolder = useStore((s) => s.setWorkspaceFolder)
  const splitSession = useStore((s) => s.splitSession)
  const [adding, setAdding] = useState(false)
  const [maximizedId, setMaximizedId] = useState<string | undefined>()
  const [editorFull, setEditorFull] = useState(false)
  const [showView, setShowView] = useState(false)
  // вид панели файлов/редактора: 'stack' — друг под другом, 'cols' — в два столбика
  const [filesLayout, setFilesLayout] = useState<'stack' | 'cols'>('stack')
  // RFC 0017 X4: вкладка правой панели — «Файлы» (дерево) или «Инспектор» (по фокус-сессии).
  const [rpTab, setRpTab] = useState<'files' | 'inspector'>('files')

  const ws = workspaces.find((w) => w.id === activeId)
  if (!ws) {
    return (
      <div className="ws-empty">
        <div>
          <h2>Нет открытого воркспейса</h2>
          <p>Создай новый кнопкой ＋ сверху или выбери слева.</p>
        </div>
      </div>
    )
  }

  const wsSessions = ws.sessionIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter(Boolean) as NonNullable<ReturnType<typeof sessions.find>>[]

  const folderEmpty = !ws.folder
  // Путь в тулбаре: если выбрана сессия в копии/своей ветке — показываем её папку.
  const focusedSession = wsSessions.find((s) => s.id === focusedId)
  const inCopy = !folderEmpty && focusedSession && focusedSession.cwd !== ws.folder
  // RFC 0013 Фаза 0: панель файлов/diff показывает рабочую копию фокус-сессии-КЛОНА
  // (своя ветка), иначе папку воркспейса — чтобы видимое = применяемому при merge-back.
  const filesFolder = diffSourceFolder(ws, sessions, focusedId)
  const shownPath = folderEmpty
    ? 'Выбрать папку'
    : (inCopy ? focusedSession!.cwd : ws.folder).replace(/^\/Users\/[^/]+/, '~')

  // выбор папки задним числом (для воркспейса, созданного без папки)
  const pickFolder = async (): Promise<void> => {
    const f = await window.api.dialog.pickFolder()
    if (f) setWorkspaceFolder(ws.id, f)
  }

  // файл развёрнут на весь экран — всё управление в плавающей панели редактора
  if (editorFull && selectedFile) {
    return (
      <div className="ws-area">
        <div className="editor-full">
          <EditorPane isFull onToggleFull={() => setEditorFull(false)} />
        </div>
      </div>
    )
  }

  return (
    <div className="ws-area">
      <div className="ws-toolbar">
        <EditableName
          className="ws-name"
          value={ws.name}
          onCommit={(v) => useStore.getState().renameWorkspace(ws.id, v)}
        />
        <button
          className={`ws-folder ${inCopy ? 'in-copy' : ''}`}
          title="Сменить папку проекта"
          onClick={pickFolder}
        >
          {inCopy ? (
            <span className="ws-folder-mark">⑂</span>
          ) : (
            <svg width="13" height="13" viewBox="0 0 16 16" className="ft-svg ft-svg-dir" aria-hidden="true">
              <path
                fill="currentColor"
                d="M1.5 4.2A1.2 1.2 0 0 1 2.7 3h3l1.3 1.3h5.3A1.2 1.2 0 0 1 13.5 5.5v6.3A1.2 1.2 0 0 1 12.3 13H2.7a1.2 1.2 0 0 1-1.2-1.2z"
              />
            </svg>
          )}
          <span className="ws-folder-path">{shownPath}</span>
        </button>
        <div className="ws-tb-right">
          {wsSessions.length > 1 && (
            <div className="ws-view-wrap">
              <button className="ws-tb-btn" onClick={() => setShowView((v) => !v)}>
                Вид
              </button>
              {showView && (
                <>
                  <div className="ctx-backdrop" onClick={() => setShowView(false)} />
                  <div className="ws-view-menu">
                    <div className="ws-view-thumbs">
                      {LAYOUTS.map((l) => (
                        <LayoutThumb
                          key={l.id}
                          // подсветка = ФАКТИЧЕСКАЯ раскладка (число панелей + текущие столбцы
                          // gridCols), а НЕ застрявший ws.layout: кнопки сплита меняют gridCols,
                          // но не layout, поэтому раньше «Вид» показывал старое. Пресеты уникальны
                          // по паре (count, cols) → совпадение точное; своя раскладка → ничего.
                          id={l.id}
                          selected={
                            l.count === wsSessions.length &&
                            colsOfLayout(l.id) === (ws.gridCols ?? colsOfLayout(ws.layout))
                          }
                          onClick={() => {
                            setLayout(ws.id, l.id)
                            setShowView(false)
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          <button className="ws-tb-btn" onClick={() => setAdding(true)}>
            ＋ Окно
          </button>
        </div>
      </div>

      <div className="ws-body-flex">
        <PanelGroup direction="horizontal" autoSaveId="ws-main-right">
          <Panel minSize={30} className="ws-main-panel">
            <PanelGrid
              sessions={wsSessions}
              cols={ws.gridCols ?? colsOfLayout(ws.layout)}
              maximizedId={maximizedId}
              onMaximize={(id) => setMaximizedId(id)}
              onRestore={() => setMaximizedId(undefined)}
              onAdd={() => setAdding(true)}
              onSplit={(afterId, dir) => splitSession(afterId, dir)}
            />
          </Panel>

          {showFiles && (
            <>
              <PanelResizeHandle className="rz rz-v big" />
              <Panel
                defaultSize={filesLayout === 'cols' ? 42 : 26}
                minSize={14}
                maxSize={60}
                className="right-panel-wrap"
              >
                <PanelGroup
                  key={filesLayout}
                  direction={filesLayout === 'cols' ? 'horizontal' : 'vertical'}
                  autoSaveId={`ws-files-editor-${filesLayout}`}
                >
                  <Panel defaultSize={filesLayout === 'cols' ? 38 : 42} minSize={10} className="rp-files">
                    <div className="rp-head">
                      {/* RFC 0017 X4: табы правой панели — «Файлы» (дерево) | «Инспектор» (фокус-сессия) */}
                      <div className="rp-tabs">
                        <button
                          className={`rp-tab ${rpTab === 'files' ? 'on' : ''}`}
                          onClick={() => setRpTab('files')}
                        >
                          ФАЙЛЫ
                        </button>
                        <button
                          className={`rp-tab ${rpTab === 'inspector' ? 'on' : ''}`}
                          onClick={() => setRpTab('inspector')}
                        >
                          ИНСПЕКТОР
                        </button>
                      </div>
                      {/* кнопки раскладки файлы/редактор нужны только для вкладки «Файлы» */}
                      {rpTab === 'files' && (
                        <div className="rp-head-tools">
                          <button
                            className={`vmode ${filesLayout === 'stack' ? 'on' : ''}`}
                            title="Файлы и редактор друг под другом"
                            onClick={() => setFilesLayout('stack')}
                          >
                            ⬓
                          </button>
                          <button
                            className={`vmode ${filesLayout === 'cols' ? 'on' : ''}`}
                            title="Файлы и редактор в два столбика"
                            onClick={() => setFilesLayout('cols')}
                          >
                            ◫
                          </button>
                        </div>
                      )}
                    </div>
                    {rpTab === 'inspector' ? (
                      // RFC 0017 X4: инспектор сессии (вместо дерева). Дерево «Файлы» цело —
                      // переключается табом, rightPanelVisible-тоггл не затронут.
                      <div className="rp-inspector">
                        <SessionInspector />
                      </div>
                    ) : folderEmpty ? (
                      <div className="rp-pick-folder">
                        <button className="btn-primary" onClick={pickFolder}>
                          Выбрать папку
                        </button>
                      </div>
                    ) : (
                      <>
                        {/* RFC 0011 A1: мягкая подсказка, если папка большая и без git */}
                        <DiffFolderHint folder={filesFolder} />
                        {/* RFC 0013: перенос правок клон-сессии в основное дерево (виден только
                            когда в фокусе «своя ветка») */}
                        <MergeControls />
                        {/* RFC 0011: изменённые файлы подсвечиваются прямо в дереве; клик
                            открывает вкладку Diff. RFC 0013 Фаза 0: для фокус-сессии-клона
                            показываем её рабочую копию (filesFolder), не папку воркспейса. */}
                        <FileTree folder={filesFolder} />
                      </>
                    )}
                  </Panel>
                  <PanelResizeHandle className={`rz ${filesLayout === 'cols' ? 'rz-v' : 'rz-h'} big`} />
                  <Panel minSize={10} className="rp-editor">
                    <EditorPane isFull={false} onToggleFull={() => setEditorFull(true)} />
                  </Panel>
                </PanelGroup>
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>

      {adding && (
        <div className="modal-backdrop" onClick={() => setAdding(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Новая сессия в «{ws.name}»</h3>
            <AddSessionForm workspaceId={ws.id} defaultFolder={ws.folder} onDone={() => setAdding(false)} />
          </div>
        </div>
      )}
    </div>
  )
}

// memo: App перерисовывается на своих стейтах (модалка нового воркспейса, палитра и т.п.) —
// без memo это каждый раз перерисовывало бы всё поддерево терминалов/дерева файлов (лаг ~1-2с
// при открытии модалки). Пропсов нет → memo пропускает любые родительские перерисовки; своя
// реактивность (подписки на стор) сохраняется.
export default memo(WorkspaceArea)
