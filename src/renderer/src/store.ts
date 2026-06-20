import { useMemo } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type {
  Group,
  Workspace,
  Session,
  Settings,
  Agent,
  SessionStatus,
  LayoutId,
  CreateSessionInput,
  PersistState,
  CustomAgent,
  WorkspacePreset,
  AgentId,
  WorktreeStats,
  TestResult,
  ChangedFile,
  BacklogTask
} from '../../shared/types'
import { GROUP_COLORS } from '../../shared/types'
import { layoutDef } from './components/layouts'

type Tab = 'workspace' | 'overview' | 'review' | 'backlog' | 'settings'

// RFC 0013 Фаза 0: папка, ПРОТИВ которой считаем изменения/diff для воркспейса.
// Если в фокусе сессия-КЛОН (своя ветка: задан cloneOf и cwd ≠ папке воркспейса) —
// берём её рабочую копию (session.cwd), чтобы «показанное = применяемому» при merge-back.
// Иначе — папка воркспейса. Сессия с иным cwd, но БЕЗ cloneOf — не клон, не трогаем.
export function diffSourceFolder(
  ws: Workspace | undefined,
  sessions: Session[],
  focusedSessionId: string | undefined
): string {
  if (!ws) return ''
  const focused = sessions.find((s) => s.id === focusedSessionId)
  if (
    focused &&
    focused.workspaceId === ws.id &&
    focused.cloneOf &&
    focused.cwd &&
    focused.cwd !== ws.folder
  ) {
    return focused.cwd
  }
  return ws.folder
}

// Открытый в редакторе файл. diff=true → показать как Monaco DiffEditor
// (было→стало против HEAD) вместо обычного редактора.
interface SelectedFile {
  path: string
  name: string
  diff?: boolean
}

interface Toast {
  id: string
  kind: string
  text: string
  title?: string
  sticky?: boolean // не исчезает сам — закрывается крестиком
}

interface State {
  loaded: boolean
  groups: Group[]
  workspaces: Workspace[]
  sessions: Session[]
  settings: Settings
  agents: Agent[]
  customAgents: CustomAgent[]
  presets: WorkspacePreset[]
  tasks: BacklogTask[]
  activeWorkspaceId?: string
  tab: Tab
  selectedFile?: SelectedFile
  // какой файл открыт в каждом воркспейсе (чтобы превью помнилось при переключении)
  selectedFileByWs: Record<string, SelectedFile | undefined>
  // открытые вкладки файлов по воркспейсам (ряд вкладок над панелью редактора)
  openTabsByWs: Record<string, SelectedFile[]>
  // тронутые агентом файлы по воркспейсам (ключ = workspaceId). RFC 0011.
  changedFiles: Record<string, ChangedFile[]>
  // RFC 0013 — последний перенос в основное дерево (для кнопки «Откатить»)
  lastMerge?: { cloneOf: string; backupSha: string; files: number }
  focusedSessionId?: string
  draggingSessionId?: string
  dragOverSessionId?: string
  toasts: Toast[]
  // Сворачивание панелей (только UI, на диск не пишем)
  sidebarCollapsed: boolean
  rightPanelVisible: boolean

  // RFC 0017 X1: открыта ли командная палитра (Cmd+K). Только runtime — на диск не пишем.
  commandPaletteOpen: boolean
  // Окно «все горячие клавиши» (кнопка ⌨ в шапке / клавиша «?»). Runtime-флаг.
  shortcutsOpen: boolean
  // RFC 0017 X2: фильтр дерева файлов «показать только изменённые». UI-флаг как
  // sidebarCollapsed/rightPanelVisible — только runtime (на диск не пишем), сбрасывается
  // при перезапуске. Семантику включения держит сам FileTree.
  fileTreeShowOnlyChanged: boolean
  // RFC 0017 X4: лёгкий «хвост» вывода сессии для инспектора. Ключ = sessionId,
  // значение = последние ~40 строк вывода (без ANSI). Только runtime — на диск НЕ пишем
  // и НЕ персистим. Это ОТДЕЛЬНАЯ лёгкая подписка от живого терминала (TerminalPane),
  // не вмешивается в его рендер. Кольцевой буфер: держим только последние строки.
  sessionOutputTail: Record<string, string[]>

  // H12/M6: функции-отписки от событий ядра (PTY/тесты/тосты/fs). Храним, чтобы
  // повторный init() сначала снял старые подписки, а не плодил дубли-слушателей.
  // Только runtime — на диск не пишем.
  _unsubscribers: Array<() => void>
  // M10: папки, для которых сейчас уже выполняется git.status (refreshChangedFiles).
  // Защита от гонки: пока запрос в полёте, повторный дебаунс не запускает дубль.
  // Только runtime.
  _refreshingFolders: Set<string>

  init: () => Promise<void>
  persist: () => void

  addGroup: (name: string) => Group
  deleteGroup: (id: string) => void
  renameGroup: (id: string, name: string) => void
  addWorkspace: (w: { name: string; folder: string; groupId?: string; layout: LayoutId }) => Workspace
  deleteWorkspace: (id: string) => void
  renameWorkspace: (id: string, name: string) => void
  setWorkspaceFolder: (id: string, folder: string) => void
  moveWorkspaceToGroup: (wsId: string, groupId?: string) => void
  setActiveWorkspace: (id: string) => void
  toggleGroup: (id: string) => void
  toggleSidebar: () => void
  toggleRightPanel: () => void
  // RFC 0017 X1: открыть/закрыть командную палитру (Cmd+K).
  setCommandPaletteOpen: (v: boolean) => void
  setShortcutsOpen: (v: boolean) => void
  // RFC 0017 X2: переключить фильтр дерева «только изменённые».
  toggleFileTreeShowOnlyChanged: () => void

  createSession: (input: CreateSessionInput) => Promise<Session | null>
  splitSession: (afterId: string, dir: 'right' | 'down') => Promise<void>
  removeSession: (id: string) => void
  // RFC 0012 (watchdog)
  killAllSessions: () => Promise<void>
  restartSession: (id: string) => Promise<void>
  worktreeStats: WorktreeStats | null
  refreshWorktreeStats: () => Promise<void>
  removeWorktreeFor: (id: string) => Promise<void>
  // RFC 0014 Фаза 2: результаты прогона тестов (по папке)
  testResults: Record<string, TestResult>
  runTests: (cwd: string) => void
  // RFC 0015: правка настроек (merge + persist)
  updateSettings: (patch: Partial<Settings>) => void
  moveSession: (workspaceId: string, fromId: string, toId: string) => void
  setGridCols: (workspaceId: string, cols?: number) => void
  setLayout: (workspaceId: string, layout: LayoutId) => void
  renameSession: (id: string, title: string) => void
  // RFC 0013 — перенести выбранные файлы фокус-сессии-клона в основное дерево; откатить
  applyMerge: (paths: string[]) => Promise<void>
  undoMerge: () => Promise<void>
  applyDetectedCli: (id: string, agentId: string, name: string) => void
  setStatus: (id: string, status: SessionStatus) => void
  setTab: (t: Tab) => void
  selectFile: (f?: SelectedFile) => void
  closeTab: (path: string) => void
  refreshChangedFiles: (workspaceId: string) => Promise<void>
  setFocused: (id?: string) => void
  setDragging: (id?: string) => void
  setDragOver: (id?: string) => void
  pushToast: (kind: string, text: string, title?: string, sticky?: boolean) => void
  dismissToast: (id: string) => void

  addCustomAgent: (name: string, command: string) => Promise<CustomAgent>
  removeCustomAgent: (id: string) => void
  savePreset: (name: string, layout: LayoutId, panels: { agentId: AgentId; clone: boolean }[]) => void
  deletePreset: (id: string) => void

  // RFC 0016 — беклог задач
  addTask: (partial?: Partial<BacklogTask>) => BacklogTask
  updateTask: (id: string, patch: Partial<BacklogTask>) => void
  deleteTask: (id: string) => void
  // отправить задачу первым промтом в новую сессию выбранного агента/воркспейса.
  // clone=true → агент получает свою ветку (git worktree), как галочка в AddSessionForm.
  sendTaskToAgent: (
    taskId: string,
    agentId: AgentId,
    workspaceId: string,
    clone?: boolean
  ) => Promise<void>
}

// RFC 0011: дебаунс рефреша списка изменений по событию fs:changed (правки сыплются
// пачками — не дёргаем git status на каждый чих). Ключ — workspaceId.
const changedDebounce: Record<string, ReturnType<typeof setTimeout>> = {}

// RFC 0017 X4: сколько последних строк вывода держим в «хвосте» для инспектора.
const SESSION_TAIL_LINES = 40

// RFC 0017 X4: убрать ANSI-управляющие последовательности (цвет/курсор/очистка), чтобы
// «хвост» в инспекторе читался как обычный текст. Лёгкая чистка — не полноценный парсер
// терминала (живой терминал рисует xterm.js в TerminalPane, это отдельный текстовый срез):
//  • CSI-последовательности  ESC[ … <буква>  (цвет, перемещение курсора и т.п.);
//  • OSC-последовательности   ESC] … (BEL | ESC\)  (заголовок окна и пр.);
//  • одиночные ESC + следующий символ;
//  • \r без \n (возврат каретки от перерисовок TUI) убираем, чтобы строки не «слипались».
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const ANSI_ESC = /\x1b[@-Z\\-_]/g
function stripAnsi(s: string): string {
  return s
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_ESC, '')
    .replace(/\r(?!\n)/g, '')
}

// RFC 0017 X4: буфер накопления хвоста вывода. Копим очищенные куски ТУТ и сбрасываем в стор
// ПАЧКОЙ раз в ~400мс (см. flushTails в init), а НЕ set() на каждый кусок — иначе при активной
// сессии set() звался 100+/сек, стор дёргал всех подписчиков → главный поток забит → кнопки
// лагают и клики теряются («надо нажать два раза»). Задержку хвоста инспектор терпит.
const tailPending: Record<string, string> = {}
let tailFlushTimer: ReturnType<typeof setTimeout> | null = null

function persistable(s: State): PersistState {
  return {
    groups: s.groups,
    workspaces: s.workspaces,
    // H8: `stalled` и `alive` — runtime-флаги (watchdog/жив ли PTY), НЕ персистим.
    // Бэкенд делает full-replace стейта, поэтому если бы stalled попал на диск, он
    // мог бы «воскреснуть» при следующей загрузке. Чистим оба здесь, чтобы то, что
    // сохранилось ≡ тому, что нарисуется после перезагрузки, а watchdog заново
    // выставит stalled при реальном зацикливании.
    sessions: s.sessions.map(({ stalled: _stalled, alive: _alive, ...rest }) => rest),
    settings: s.settings,
    customAgents: s.customAgents,
    presets: s.presets,
    tasks: s.tasks,
    activeWorkspaceId: s.activeWorkspaceId
  }
}

export const useStore = create<State>((set, get) => ({
  loaded: false,
  groups: [],
  workspaces: [],
  sessions: [],
  worktreeStats: null,
  testResults: {},
  settings: {
    soundOnDone: true,
    notifyOnDone: true,
    defaultShell: '/bin/zsh',
    claudePermissionMode: '',
    codexApproval: '',
    codexSandbox: ''
  },
  agents: [],
  customAgents: [],
  presets: [],
  tasks: [],
  tab: 'workspace',
  toasts: [],
  sidebarCollapsed: false,
  rightPanelVisible: true,
  commandPaletteOpen: false,
  shortcutsOpen: false,
  fileTreeShowOnlyChanged: false,
  sessionOutputTail: {},
  selectedFileByWs: {},
  openTabsByWs: {},
  changedFiles: {},
  _unsubscribers: [],
  _refreshingFolders: new Set<string>(),

  init: async () => {
    try {
      const [state, agents] = await Promise.all([
        window.api.state.get(),
        window.api.agents.list()
      ])
      set({
        loaded: true,
        groups: state.groups,
        workspaces: state.workspaces,
        // H8: runtime-флаги сбрасываем на загрузке — процессы ещё не подняты (alive=false),
        // зацикливания нет, пока watchdog не сообщит заново (stalled=false).
        sessions: state.sessions.map((s) => ({ ...s, alive: false, stalled: false })),
        settings: state.settings,
        customAgents: state.customAgents ?? [],
        presets: state.presets ?? [],
        tasks: state.tasks ?? [],
        activeWorkspaceId: state.activeWorkspaceId,
        agents
      })
    } catch (e) {
      // Ядро недоступно (или открыто в обычном браузере без Tauri) —
      // поднимаем интерфейс с пустыми данными, чтобы он не «висел».
      set({ loaded: true })
      console.error('init failed:', e)
    }
    // H12/M6: снимаем прежние подписки перед новыми (повторный init не плодит дубли
    // слушателей — иначе одно событие ptyStatus прилетало бы во все накопленные).
    // Для штатного единственного init() список пуст → поведение идентично прежнему.
    get()._unsubscribers.forEach((u) => {
      try {
        u()
      } catch {
        /* отписка не должна валить init */
      }
    })
    // подписки на события PTY (в браузере без среды просто молча пропускаем)
    try {
      const unsubs: Array<() => void> = []
      unsubs.push(window.api.on.ptyStatus((id, status) => get().setStatus(id, status)))
      unsubs.push(
        window.api.on.ptyExit((id) =>
          set((st) => ({
            sessions: st.sessions.map((s) => (s.id === id ? { ...s, alive: false } : s))
          }))
        )
      )
      // RFC 0012 watchdog: агент завис/зациклился → флаг на сессии (⚠ + кнопка ↻)
      unsubs.push(
        window.api.on.ptyStalled((id, stalled) =>
          set((st) => ({
            sessions: st.sessions.map((s) => (s.id === id ? { ...s, stalled } : s))
          }))
        )
      )
      // RFC 0014 Фаза 2: результат прогона тестов → в стор + тост по завершении
      unsubs.push(
        window.api.on.testResult((r) => {
          set((st) => ({ testResults: { ...st.testResults, [r.cwd]: r } }))
          if (!r.running) {
            if (r.error) get().pushToast('error', `Тесты: ${r.error}`)
            else if (r.ok) get().pushToast('info', `✅ Тесты прошли (${r.command})`)
            else get().pushToast('error', `❌ Тесты упали (код ${r.code ?? '?'}, ${r.command})`)
          }
        })
      )
      unsubs.push(window.api.on.toast((kind, text) => get().pushToast(kind, text)))
      // авто-переименование шелл-сессии, когда в ней запустили CLI (split → claude и т.п.)
      unsubs.push(
        window.api.on.cliDetected((id, agentId, name) => get().applyDetectedCli(id, agentId, name))
      )
      // RFC 0011: в папке воркспейса что-то изменилось → обновить список «Изменения»
      // (дебаунс ~400мс, чтобы не дёргать git status на каждую правку файла).
      unsubs.push(
        window.api.on.fsChanged((root) => {
          // L3: воркспейс мог быть удалён, пока сыпались fs-события — не планируем для него рефреш
          const ws = get().workspaces.find((w) => w.folder === root)
          if (!ws) return
          clearTimeout(changedDebounce[ws.id])
          changedDebounce[ws.id] = setTimeout(() => get().refreshChangedFiles(ws.id), 400)
        })
      )
      // RFC 0017 X4: лёгкий «хвост» вывода для инспектора сессии. ОТДЕЛЬНАЯ подписка от
      // живого терминала (TerminalPane) — она НЕ трогает рендер xterm.js, лишь копит
      // последние ~40 строк текста на сессию (ANSI вычищен) в кольцевой буфер.
      // Сброс накопленного хвоста в стор ПАЧКОЙ (раз в ~400мс) — не на каждый кусок вывода.
      const flushTails = (): void => {
        const ids = Object.keys(tailPending)
        if (ids.length === 0) return
        // снимок + очистка буфера атомарны (JS однопоточный) — новые куски пойдут в новый цикл
        const snap: Record<string, string> = {}
        for (const id of ids) {
          snap[id] = tailPending[id]
          delete tailPending[id]
        }
        set((st) => {
          const tail = { ...st.sessionOutputTail }
          for (const id of ids) {
            const prev = tail[id] ?? []
            // Куски нарезаны как угодно: дописываем к последней строке, затем режем по \n —
            // строки не дробятся на границах кусков.
            const merged = (prev.length ? prev[prev.length - 1] : '') + snap[id]
            const head = prev.slice(0, -1)
            const lines = merged.split('\n')
            tail[id] = [...head, ...lines].slice(-SESSION_TAIL_LINES)
          }
          return { sessionOutputTail: tail }
        })
      }
      unsubs.push(
        window.api.on.ptyData((id, data) => {
          const clean = stripAnsi(data)
          if (!clean) return
          tailPending[id] = (tailPending[id] ?? '') + clean
          if (tailFlushTimer === null) {
            tailFlushTimer = setTimeout(() => {
              tailFlushTimer = null
              flushTails()
            }, 400)
          }
        })
      )
      set({ _unsubscribers: unsubs })
    } catch (e) {
      console.error('subscribe failed:', e)
    }
  },

  persist: () => window.api.state.save(persistable(get())),

  addGroup: (name) => {
    const g: Group = {
      id: crypto.randomUUID(),
      name,
      color: GROUP_COLORS[get().groups.length % GROUP_COLORS.length]
    }
    set((s) => ({ groups: [...s.groups, g] }))
    get().persist()
    return g
  },

  // Удаление группы: воркспейсы НЕ теряем — открепляем (уедут в UNGROUPED).
  deleteGroup: (id) => {
    set((s) => ({
      groups: s.groups.filter((g) => g.id !== id),
      workspaces: s.workspaces.map((w) => (w.groupId === id ? { ...w, groupId: undefined } : w))
    }))
    get().persist()
  },

  renameGroup: (id, name) => {
    set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)) }))
    get().persist()
  },

  addWorkspace: (w) => {
    const ws: Workspace = {
      id: crypto.randomUUID(),
      name: w.name,
      folder: w.folder,
      groupId: w.groupId,
      layout: w.layout,
      sessionIds: []
    }
    set((s) => ({ workspaces: [...s.workspaces, ws], activeWorkspaceId: ws.id, tab: 'workspace' }))
    get().persist()
    return ws
  },

  deleteWorkspace: (id) => {
    const ws = get().workspaces.find((w) => w.id === id)
    ws?.sessionIds.forEach((sid) => window.api.pty.kill(sid))
    // L3: гасим висящий дебаунс-таймер git-status этого воркспейса и убираем ключ,
    // иначе он отработает уже по удалённому id (и map таймеров растёт без чистки).
    clearTimeout(changedDebounce[id])
    delete changedDebounce[id]
    set((s) => {
      // чистим хвосты вывода сессий удаляемого воркспейса (иначе sessionOutputTail растёт)
      const tail = { ...s.sessionOutputTail }
      ws?.sessionIds.forEach((sid) => delete tail[sid])
      return {
        workspaces: s.workspaces.filter((w) => w.id !== id),
        // Группу НЕ удаляем, даже если она опустела — чтобы можно было снова добавить в неё
        // воркспейс (пустая группа остаётся в сайдбаре с кнопкой «＋»). Удаляется только вручную.
        sessions: s.sessions.filter((x) => x.workspaceId !== id),
        activeWorkspaceId: s.activeWorkspaceId === id ? undefined : s.activeWorkspaceId,
        sessionOutputTail: tail
      }
    })
    get().persist()
  },

  renameWorkspace: (id, name) => {
    set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name } : w)) }))
    get().persist()
  },

  setWorkspaceFolder: (id, folder) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, folder } : w))
    }))
    get().persist()
  },

  // Перенос воркспейса в группу (groupId) или из группы (undefined = «без группы»).
  // Пустую группу после переноса НЕ удаляем — пользователь может оставить её.
  moveWorkspaceToGroup: (wsId, groupId) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === wsId ? { ...w, groupId } : w))
    }))
    get().persist()
  },

  setActiveWorkspace: (id) => {
    // восстанавливаем превью, открытое в этом воркспейсе ранее
    set((s) => ({ activeWorkspaceId: id, tab: 'workspace', selectedFile: s.selectedFileByWs[id] }))
    // запускаем PTY для сессий воркспейса, если ещё не живы
    const ws = get().workspaces.find((w) => w.id === id)
    ws?.sessionIds.forEach(async (sid) => {
      // M7: читаем СВЕЖИЙ снимок (а не закэшированный до await) — между стартами
      // другая операция могла поменять список сессий; работаем на текущем стейте.
      const s = get().sessions.find((x) => x.id === sid)
      if (s && !(await window.api.session.isAlive(sid))) {
        await window.api.session.start(s)
        set((cur) => ({
          // если сессию успели удалить, пока стартовали — map просто её не найдёт
          sessions: cur.sessions.map((x) => (x.id === sid ? { ...x, alive: true } : x))
        }))
      }
    })
    // RFC 0011: обновить список тронутых файлов при переключении воркспейса
    get().refreshChangedFiles(id)
    get().persist()
  },

  toggleGroup: (id) => {
    set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)) }))
    get().persist()
  },

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleRightPanel: () => set((s) => ({ rightPanelVisible: !s.rightPanelVisible })),

  // RFC 0017 X1: открыть/закрыть командную палитру (runtime, не персистим).
  setCommandPaletteOpen: (v) => set({ commandPaletteOpen: v }),
  setShortcutsOpen: (v) => set({ shortcutsOpen: v }),
  // RFC 0017 X2: фильтр дерева «только изменённые» (runtime, как панели — не персистим).
  toggleFileTreeShowOnlyChanged: () =>
    set((s) => ({ fileTreeShowOnlyChanged: !s.fileTreeShowOnlyChanged })),

  createSession: async (input) => {
    try {
      const session = await window.api.session.create(input)
      set((s) => ({
        sessions: [...s.sessions, session],
        workspaces: s.workspaces.map((w) =>
          w.id === input.workspaceId ? { ...w, sessionIds: [...w.sessionIds, session.id] } : w
        ),
        focusedSessionId: session.id
      }))
      get().persist()
      return session
    } catch (e) {
      get().pushToast('error', `Не удалось создать сессию: ${e}`)
      return null
    }
  },

  // Разделить окно: МГНОВЕННО (без формы) открыть соседнюю сессию — ПУСТОЙ шелл-терминал
  // (agentId 'shell') в папке воркспейса, куда можно сразу вводить команды. Направление:
  //  • «вправо» = вставить соседом + увеличить колонки (ляжет правее в том же ряду);
  //  • «вниз»   = вставить соседом + уменьшить колонки (уйдёт на ряд ниже/в стек).
  // gridCols глобальный на воркспейс — для 1→2 окон делит ровно пополам; при многих
  // окнах «вниз» стекует всё (ограничение плоской модели, приемлемо).
  splitSession: async (afterId, dir) => {
    const src = get().sessions.find((s) => s.id === afterId)
    if (!src) return
    const ws = get().workspaces.find((w) => w.id === src.workspaceId)
    try {
      const session = await window.api.session.create({
        workspaceId: src.workspaceId,
        agentId: 'shell', // пустой терминал, не копия CLI источника
        cwd: ws?.folder // папка воркспейса (не клон-папка источника)
      })
      set((s) => ({
        sessions: [...s.sessions, session],
        workspaces: s.workspaces.map((w) => {
          if (w.id !== src.workspaceId) return w
          const ids = [...w.sessionIds]
          const at = ids.indexOf(afterId)
          ids.splice(at < 0 ? ids.length : at + 1, 0, session.id)
          const total = ids.length
          const curCols = w.gridCols ?? layoutDef(w.layout).cols.split(' ').length
          const gridCols =
            dir === 'right' ? Math.min(curCols + 1, total) : Math.max(1, curCols - 1)
          return { ...w, sessionIds: ids, gridCols }
        }),
        focusedSessionId: session.id
      }))
      get().persist()
    } catch (e) {
      get().pushToast('error', `Не удалось разделить окно: ${e}`)
    }
  },

  removeSession: (id) => {
    window.api.pty.kill(id)
    set((s) => {
      // чистим хвост вывода удалённой сессии — иначе sessionOutputTail растёт вечно
      const { [id]: _drop, ...tail } = s.sessionOutputTail
      return {
        sessions: s.sessions.filter((x) => x.id !== id),
        workspaces: s.workspaces.map((w) => ({
          ...w,
          sessionIds: w.sessionIds.filter((sid) => sid !== id)
        })),
        sessionOutputTail: tail
      }
    })
    get().persist()
  },

  // RFC 0012 (watchdog): убить ВСЕ сессии (паника). Процессы гаснут, сессии остаются (серые),
  // их можно поднять заново кликом (resume сохраняется).
  killAllSessions: async () => {
    await window.api.pty.killAll()
    set((s) => ({
      sessions: s.sessions.map((x) => ({ ...x, alive: false, stalled: false, status: 'idle' as SessionStatus }))
    }))
    get().pushToast('info', 'Все агенты остановлены')
  },

  // RFC 0012: рестарт зависшей сессии в один клик (убить + поднять заново тем же resume-путём).
  restartSession: async (id) => {
    const sess = get().sessions.find((x) => x.id === id)
    if (!sess) return
    const ok = await window.api.session.restart(sess)
    set((cur) => ({
      sessions: cur.sessions.map((x) =>
        x.id === id ? { ...x, alive: ok, stalled: false, status: 'idle' as SessionStatus } : x
      )
    }))
  },

  refreshWorktreeStats: async () => {
    try {
      const st = await window.api.worktree.stats()
      set({ worktreeStats: st })
    } catch {
      /* нет данных — индикатор просто не показываем */
    }
  },

  // RFC 0014 Фаза 2: запустить тесты для папки (результат придёт событием test:result)
  runTests: (cwd) => {
    set((s) => ({ testResults: { ...s.testResults, [cwd]: { cwd, running: true } } }))
    window.api.tests.run(cwd)
  },

  // RFC 0015: правка настроек (merge + persist на бэк)
  updateSettings: (patch) => {
    set((s) => ({ settings: { ...s.settings, ...patch } }))
    get().persist()
  },

  // RFC 0012: убрать «свою ветку» с диска (после kill) + выкинуть сессию.
  removeWorktreeFor: async (id) => {
    const sess = get().sessions.find((x) => x.id === id)
    if (!sess || !sess.cloneOf) return
    window.api.pty.kill(id)
    const r = await window.api.worktree.remove(sess.cwd, sess.cloneOf ?? null)
    if (r.ok) {
      get().removeSession(id)
      get().refreshWorktreeStats()
      get().pushToast('info', 'Ветка убрана с диска')
    } else {
      get().pushToast('error', `Не убрать ветку: ${r.error ?? ''}`)
    }
  },

  // Перестановка окон: переносим fromId на место toId, остальные сдвигаются.
  moveSession: (workspaceId, fromId, toId) => {
    if (fromId === toId) return
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w
        const ids = [...w.sessionIds]
        const from = ids.indexOf(fromId)
        if (from < 0) return w
        ids.splice(from, 1)
        const to = ids.indexOf(toId)
        const insertAt = to < 0 ? ids.length : to
        ids.splice(insertAt, 0, fromId)
        return { ...w, sessionIds: ids }
      })
    }))
    get().persist()
  },

  setGridCols: (workspaceId, cols) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === workspaceId ? { ...w, gridCols: cols } : w))
    }))
    get().persist()
  },

  setLayout: (workspaceId, layout) => {
    set((s) => ({
      // меняем раскладку и сбрасываем ручное число столбцов
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, layout, gridCols: undefined } : w
      )
    }))
    get().persist()
  },

  renameSession: (id, title) => {
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, title } : x)) }))
    get().persist()
  },

  // Ядро определило, какой CLI запустили внутри шелл-сессии (split). Меняем агента
  // (серый ярлык «Shell» → «Claude Code» и т.п.). Заголовок переименовываем ТОЛЬКО если
  // он ещё дефолтный (= имя текущего агента, напр. «Shell») — пользовательское имя не трогаем.
  applyDetectedCli: (id, agentId, name) => {
    set((s) => ({
      sessions: s.sessions.map((x) => {
        if (x.id !== id) return x
        const curAgentName = s.agents.find((a) => a.id === x.agentId)?.name ?? x.agentId
        const title = x.title === curAgentName ? name : x.title
        return { ...x, agentId, title }
      })
    }))
    get().persist()
  },

  setStatus: (id, status) => {
    // Только обновляем статус (рамка/счётчики). Авто-уведомления отключены: эвристика
    // по выводу «дёргается» на перерисовках TUI агента → спам ложных «закончила».
    // Точные уведомления вернём через хуки агентов (RFC 0003).
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, status } : x))
    }))
    // RFC 0011: агент закончил ход (статус → ready) — момент посмотреть, что наделал.
    if (status === 'ready') {
      const wsId = get().sessions.find((x) => x.id === id)?.workspaceId
      if (wsId) get().refreshChangedFiles(wsId)
    }
  },

  setTab: (t) => set({ tab: t }),
  selectFile: (f) => {
    const wsId = get().activeWorkspaceId
    set((s) => {
      if (!wsId) return { selectedFile: f }
      // открытие файла = добавить вкладку (дедуп по пути) и сделать её активной.
      let tabs = s.openTabsByWs[wsId] ?? []
      if (f) {
        tabs = tabs.some((t) => t.path === f.path)
          ? tabs.map((t) => (t.path === f.path ? f : t)) // обновить (напр. diff-флаг)
          : [...tabs, f]
      }
      return {
        selectedFile: f,
        selectedFileByWs: { ...s.selectedFileByWs, [wsId]: f },
        openTabsByWs: { ...s.openTabsByWs, [wsId]: tabs }
      }
    })
  },
  closeTab: (path) => {
    const wsId = get().activeWorkspaceId
    if (!wsId) return
    set((s) => {
      const tabs = (s.openTabsByWs[wsId] ?? []).filter((t) => t.path !== path)
      // если закрыли активную вкладку — активной становится последняя оставшаяся (или ничего)
      const active =
        s.selectedFile?.path === path ? (tabs.length ? tabs[tabs.length - 1] : undefined) : s.selectedFile
      return {
        openTabsByWs: { ...s.openTabsByWs, [wsId]: tabs },
        selectedFile: active,
        selectedFileByWs: { ...s.selectedFileByWs, [wsId]: active }
      }
    })
  },

  // RFC 0011: перечитать список тронутых агентом файлов воркспейса (git status
  // его папки). Не-git папка / ошибка → пустой список (ядро вернёт []).
  refreshChangedFiles: async (workspaceId) => {
    const st = get()
    const ws = st.workspaces.find((w) => w.id === workspaceId)
    // RFC 0013 Фаза 0: источник = рабочая копия фокус-сессии-клона, иначе папка воркспейса.
    const folder = diffSourceFolder(ws, st.sessions, st.focusedSessionId)
    if (!folder) {
      set((s) => ({ changedFiles: { ...s.changedFiles, [workspaceId]: [] } }))
      return
    }
    // M10: если git.status по этой папке уже в полёте — не запускаем дубль (дебаунс мог
    // выстрелить повторно, пока запрос ещё считается). Свежее состояние всё равно
    // подтянет следующий тик дебаунса/смена фокуса.
    if (st._refreshingFolders.has(folder)) return
    st._refreshingFolders.add(folder)
    try {
      const files = await window.api.git.status(folder)
      set((s) => ({ changedFiles: { ...s.changedFiles, [workspaceId]: files } }))
    } catch {
      /* нет ядра (браузер без Tauri) — молча пропускаем */
    } finally {
      get()._refreshingFolders.delete(folder)
    }
  },
  setFocused: (id) => {
    set({ focusedSessionId: id })
    // сообщаем ядру активную сессию — чтобы не слать уведомление, когда юзер уже в этом окне
    try {
      window.api.session.setActive(id ?? null)
    } catch {
      /* нет ядра (браузер без Tauri) */
    }
    // RFC 0013 Фаза 0: смена фокуса между сессиями меняет источник diff (клон↔основная) —
    // перечитать изменения воркспейса этой сессии.
    const st = get()
    const sess = st.sessions.find((s) => s.id === id)
    const wsId = sess?.workspaceId ?? st.activeWorkspaceId
    if (wsId) st.refreshChangedFiles(wsId)
  },
  // RFC 0013 — перенести выбранные файлы фокус-сессии-клона (своя ветка) в основное дерево.
  // Источник worktree = session.cwd, цель = session.cloneOf. Вся безопасность — в ядре
  // (merge_transfer): конфликт → ok=false, основное не тронуто; успех → точка отката.
  applyMerge: async (paths) => {
    const st = get()
    const sess = st.sessions.find((s) => s.id === st.focusedSessionId)
    if (!sess || !sess.cloneOf || !sess.cwd || sess.cwd === '' || paths.length === 0) {
      st.pushToast('error', 'Нет ветки агента для переноса')
      return
    }
    try {
      const res = await window.api.merge.applyFiles(sess.cwd, sess.cloneOf, paths)
      if (res.ok) {
        set({ lastMerge: { cloneOf: sess.cloneOf, backupSha: res.backupSha ?? '', files: res.appliedFiles } })
        st.pushToast('info', `Перенесено в main: ${res.appliedFiles} файл(ов)`)
      } else if (res.conflicts && res.conflicts.length) {
        st.pushToast('error', `Не перенёс — main не тронут: ${res.conflicts.join(', ')}`, undefined, true)
      } else {
        st.pushToast('error', `Перенос не удался: ${res.error ?? 'неизвестно'}`, undefined, true)
      }
    } catch (e) {
      st.pushToast('error', `Перенос не удался: ${e}`)
    }
  },
  undoMerge: async () => {
    const st = get()
    const lm = st.lastMerge
    if (!lm || !lm.backupSha) return
    try {
      const r = await window.api.merge.undo(lm.cloneOf, lm.backupSha)
      if (r.ok) {
        st.pushToast('info', 'Перенос откатан — main вернулся к состоянию до переноса')
        set({ lastMerge: undefined })
      } else {
        st.pushToast('error', `Откат не удался: ${r.error ?? 'неизвестно'}`, undefined, true)
      }
    } catch (e) {
      st.pushToast('error', `Откат не удался: ${e}`)
    }
  },
  setDragging: (id) => set({ draggingSessionId: id }),
  setDragOver: (id) => set({ dragOverSessionId: id }),

  pushToast: (kind, text, title, sticky) => {
    const id = crypto.randomUUID()
    set((s) => ({ toasts: [...s.toasts, { id, kind, text, title, sticky }] }))
    // sticky-уведомления (о сессиях) висят, пока не закроют крестиком
    if (!sticky) setTimeout(() => get().dismissToast(id), 6000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  // Свой CLI: сохраняем в состояние и СРАЗУ пишем на диск (await), чтобы
  // главный процесс уже видел его при создании сессии.
  addCustomAgent: async (name, command) => {
    const agent: CustomAgent = { id: `custom:${crypto.randomUUID()}`, name, command }
    set((s) => ({ customAgents: [...s.customAgents, agent] }))
    await window.api.state.save(persistable(get()))
    return agent
  },
  removeCustomAgent: (id) => {
    set((s) => ({ customAgents: s.customAgents.filter((c) => c.id !== id) }))
    get().persist()
  },

  savePreset: (name, layout, panels) => {
    const p: WorkspacePreset = { id: crypto.randomUUID(), name, layout, panels }
    set((s) => ({ presets: [...s.presets, p] }))
    get().persist()
  },
  deletePreset: (id) => {
    set((s) => ({ presets: s.presets.filter((p) => p.id !== id) }))
    get().persist()
  },

  // RFC 0016 — беклог: добавить задачу (дефолт — черновик-идея, пустые поля).
  addTask: (partial) => {
    const task: BacklogTask = {
      id: crypto.randomUUID(),
      title: partial?.title ?? '',
      description: partial?.description ?? '',
      kind: partial?.kind ?? 'idea',
      attachments: partial?.attachments ?? [],
      status: partial?.status ?? 'draft',
      createdAt: partial?.createdAt ?? new Date().toISOString(),
      sentSessionId: partial?.sentSessionId
    }
    set((s) => ({ tasks: [task, ...s.tasks] }))
    get().persist()
    return task
  },

  updateTask: (id, patch) => {
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
    get().persist()
  },

  deleteTask: (id) => {
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }))
    get().persist()
  },

  // RFC 0016 «В работу»: текст задачи (+пути скринов) → первым промтом в новую сессию
  // выбранного агента/воркспейса. Переиспользуем готовый createSession (та же дорога,
  // что у AddSessionForm). Помечаем задачу sent + храним sentSessionId (аудит, разовая
  // отправка). Переключаемся в воркспейс и фокусируем новую сессию — пилот сразу видит её.
  sendTaskToAgent: async (taskId, agentId, workspaceId, clone) => {
    const st = get()
    const task = st.tasks.find((t) => t.id === taskId)
    if (!task) return
    const ws = st.workspaces.find((w) => w.id === workspaceId)
    if (!ws) {
      st.pushToast('error', 'Воркспейс не найден')
      return
    }
    const firstPrompt =
      task.title +
      (task.description ? '\n\n' + task.description : '') +
      (task.attachments.length ? '\n\nСкриншоты: ' + task.attachments.join(', ') : '')
    const session = await st.createSession({
      workspaceId,
      agentId,
      cwd: ws.folder || undefined,
      clone, // своя ветка (git worktree), если пилот поставил галочку в SendPicker
      firstPrompt: firstPrompt.trim() || undefined
    })
    if (!session) return // createSession уже показал тост об ошибке
    // помечаем задачу отправленной + запоминаем сессию
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, status: 'sent' as const, sentSessionId: session.id } : t
      )
    }))
    get().persist()
    // показываем результат: открываем воркспейс и фокусируем новую сессию
    st.setActiveWorkspace(workspaceId)
    st.setFocused(session.id)
    st.setTab('workspace')
    st.pushToast('info', `Задача отправлена агенту: ${task.title || 'без названия'}`)
  }
}))

// ── Перф-селекторы (узкая подписка на стор) ─────────────────────────────────
// Проблема: компоненты, подписанные на весь `s.sessions`, перерисовываются при
// ЛЮБОЙ смене статуса любой сессии (setStatus каждый раз создаёт новый массив).
// Эти хелперы дают узкий срез + сравнение по содержимому (useShallow): пока сам
// срез не изменился по значению — re-render не происходит, но КАК ТОЛЬКО статус
// нужной сессии меняется, срез меняется и подписчик честно перерисовывается
// (реактивность не теряется). Подключение на конкретных call-site'ах — за их
// владельцами; здесь только инструмент, существующие ключи стора не переименованы.

// Одна сессия по id (или undefined). Меняется → перерисовка только этого подписчика.
export const useSession = (id: string | undefined): Session | undefined =>
  useStore((s) => (id ? s.sessions.find((x) => x.id === id) : undefined))

// Только статус одной сессии — самый частый источник перерисовок (рамка/значок).
export const useSessionStatus = (id: string | undefined): SessionStatus | undefined =>
  useStore((s) => (id ? s.sessions.find((x) => x.id === id)?.status : undefined))

// Флаг зацикливания (watchdog) одной сессии — для ⚠ + кнопки ↻ без подписки на массив.
export const useSessionStalled = (id: string | undefined): boolean =>
  useStore((s) => (id ? (s.sessions.find((x) => x.id === id)?.stalled ?? false) : false))

// Сессии одного воркспейса (по содержимому). Стабильна, пока не изменился именно
// этот срез — смена сессии чужого воркспейса не перерисует подписчика.
export const useWorkspaceSessions = (workspaceId: string | undefined): Session[] =>
  useStore(
    useShallow((s) =>
      workspaceId ? s.sessions.filter((x) => x.workspaceId === workspaceId) : []
    )
  )

// Лёгкая выжимка статусов воркспейса (id+status) для сайдбара/обзора — не тянет
// весь объект сессии, перерисовка только когда меняется набор/статусы среза.
export const useWorkspaceStatuses = (
  workspaceId: string | undefined
): Array<{ id: string; status: SessionStatus }> =>
  useStore(
    useShallow((s) =>
      workspaceId
        ? s.sessions
            .filter((x) => x.workspaceId === workspaceId)
            .map((x) => ({ id: x.id, status: x.status }))
        : []
    )
  )

// ── RFC 0017 X4: «хвост» вывода сессии для инспектора ───────────────────────
// Последние ~40 строк вывода одной сессии (ANSI вычищен). Узкая подписка: меняется
// только когда пришёл новый вывод именно этой сессии. Пустой массив, если вывода ещё нет.
export const useSessionTail = (id: string | undefined): string[] =>
  useStore(useShallow((s) => (id ? (s.sessionOutputTail[id] ?? []) : [])))

// ── RFC 0017 X2/X3/X4: общий селектор конфликтов «две сессии правят один файл» ──
// Единый источник истины для пометки конфликтов (вынесено из Review.tsx, семантика
// идентична). Ключ конфликта = base + '::' + относительный путь файла, где base —
// cloneOf для сессии-клона (своя ветка), иначе папка воркспейса (= база ключа в Review).
// Если по одному ключу правят ≥2 ЖИВЫХ дерева (юнита) — это конфликт.
//
// • conflictKeys — Set ключей-конфликтов (FileTree X2: пометить файл ⚠).
// • editorsByKey — Map ключ → список id сессий, правящих этот файл (SessionInspector X4:
//   «кто ещё правит этот файл»; Review X3: подсветка/предупреждение).
//
// Источник git-статусов — store.changedFiles[workspaceId] (наполняется refreshChangedFiles
// по папке-источнику diffSourceFolder того воркспейса). Важно: changedFiles[ws.id] держит
// изменения РОВНО ОДНОГО дерева — фокус-сессии-клона, если она в фокусе этого воркспейса,
// иначе основной папки воркспейса (см. diffSourceFolder). Поэтому файлы относим к ТОМУ
// дереву, что реально отражено в changedFiles (без ложных «правит всё подряд» по всем
// клонам сразу). Конфликт по одному base-ключу всё равно проявится, когда два разных
// дерева делят одну базу (напр. клон с cloneOf == папке другого воркспейса, или два
// воркспейса на одной папке) — ровно как в Review, где такие юниты считаются вместе.
export interface ConflictInfo {
  conflictKeys: Set<string>
  editorsByKey: Map<string, string[]>
}

// Сырьё для расчёта конфликтов: только структурные поля сессий (id/ws/clone/cwd/folder),
// фокус и git-изменения. Узкая подписка (useShallow по строке-подписи) — пересчёт ТОЛЬКО
// когда реально меняется состав/изменения, не на каждый статус-тик. Set/Map нельзя сравнить
// shallow по содержимому, поэтому строим их в useMemo по этой стабильной подписи (как Review
// мемоизирует units/conflictKeys), а не возвращаем новые Set/Map на каждый рендер.
function conflictSignature(s: State): string {
  const sess = s.sessions
    .map((x) => `${x.id}|${x.workspaceId}|${x.cloneOf ?? ''}|${x.cwd}`)
    .join(';')
  const ws = s.workspaces.map((w) => `${w.id}|${w.folder}`).join(';')
  const chg = s.workspaces
    .map((w) => w.id + '#' + (s.changedFiles[w.id] ?? []).map((f) => f.path).join(','))
    .join(';')
  return `${sess}##${ws}##${chg}##${s.focusedSessionId ?? ''}`
}

export function useConflictInfo(): ConflictInfo {
  // Подписываемся ТОЛЬКО на строку-подпись (примитив) — компонент перерисуется лишь когда
  // меняется состав сессий/папок/изменений/фокуса, а НЕ на каждый статус-тик. Само сырьё
  // читаем из getState() внутри useMemo (на момент пересчёта оно консистентно с подписью).
  const sig = useStore(conflictSignature)
  return useMemo<ConflictInfo>(() => {
    const { sessions, workspaces, changedFiles, focusedSessionId } = useStore.getState()
    // ключ конфликта → набор id сессий, правящих этот файл (Set для дедупа сессий)
    const editors = new Map<string, Set<string>>()
    workspaces.forEach((ws) => {
      const wsSessions = sessions.filter((x) => x.workspaceId === ws.id)
      if (wsSessions.length === 0) return
      const files = changedFiles[ws.id] ?? []
      if (files.length === 0) return
      const isClone = (x: Session): boolean => !!(x.cloneOf && x.cwd && x.cwd !== ws.folder)
      // Какое дерево отражено в changedFiles[ws.id]: фокус-сессия-клон этого воркспейса
      // (если она в фокусе) — иначе основное дерево воркспейса. Это та же развилка, что
      // в diffSourceFolder, по которой refreshChangedFiles и собрал эти файлы.
      const focused = wsSessions.find((x) => x.id === focusedSessionId)
      const focusIsClone = !!focused && isClone(focused)
      // base ключа (как в Review) + список сессий, делящих это дерево
      const base = focusIsClone ? (focused!.cloneOf ?? focused!.cwd) : ws.folder
      const treeSessions = focusIsClone
        ? [focused!.id]
        : wsSessions.filter((x) => !isClone(x)).map((x) => x.id)
      if (treeSessions.length === 0) return
      files.forEach((f) => {
        const k = base + '::' + f.path
        let set = editors.get(k)
        if (!set) editors.set(k, (set = new Set<string>()))
        treeSessions.forEach((id) => set!.add(id))
      })
    })
    const conflictKeys = new Set<string>()
    const editorsByKey = new Map<string, string[]>()
    editors.forEach((set, k) => {
      const ids = Array.from(set)
      editorsByKey.set(k, ids)
      if (ids.length >= 2) conflictKeys.add(k)
    })
    return { conflictKeys, editorsByKey }
    // sig — стабильная подпись всех входов; sessions/workspaces/changedFiles читаются внутри.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
}
