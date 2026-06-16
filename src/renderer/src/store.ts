import { create } from 'zustand'
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
  ChangedFile
} from '../../shared/types'
import { GROUP_COLORS } from '../../shared/types'
import { layoutDef } from './components/layouts'

type Tab = 'workspace' | 'overview' | 'review' | 'settings'

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
  activeWorkspaceId?: string
  tab: Tab
  selectedFile?: SelectedFile
  // какой файл открыт в каждом воркспейсе (чтобы превью помнилось при переключении)
  selectedFileByWs: Record<string, SelectedFile | undefined>
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
}

// RFC 0011: дебаунс рефреша списка изменений по событию fs:changed (правки сыплются
// пачками — не дёргаем git status на каждый чих). Ключ — workspaceId.
const changedDebounce: Record<string, ReturnType<typeof setTimeout>> = {}

function persistable(s: State): PersistState {
  return {
    groups: s.groups,
    workspaces: s.workspaces,
    sessions: s.sessions,
    settings: s.settings,
    customAgents: s.customAgents,
    presets: s.presets,
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
  tab: 'workspace',
  toasts: [],
  sidebarCollapsed: false,
  rightPanelVisible: true,
  selectedFileByWs: {},
  changedFiles: {},

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
        sessions: state.sessions.map((s) => ({ ...s, alive: false })),
        settings: state.settings,
        customAgents: state.customAgents ?? [],
        presets: state.presets ?? [],
        activeWorkspaceId: state.activeWorkspaceId,
        agents
      })
    } catch (e) {
      // Ядро недоступно (или открыто в обычном браузере без Tauri) —
      // поднимаем интерфейс с пустыми данными, чтобы он не «висел».
      set({ loaded: true })
      console.error('init failed:', e)
    }
    // подписки на события PTY (в браузере без среды просто молча пропускаем)
    try {
      window.api.on.ptyStatus((id, status) => get().setStatus(id, status))
      window.api.on.ptyExit((id) =>
        set((st) => ({
          sessions: st.sessions.map((s) => (s.id === id ? { ...s, alive: false } : s))
        }))
      )
      // RFC 0012 watchdog: агент завис/зациклился → флаг на сессии (⚠ + кнопка ↻)
      window.api.on.ptyStalled((id, stalled) =>
        set((st) => ({
          sessions: st.sessions.map((s) => (s.id === id ? { ...s, stalled } : s))
        }))
      )
      // RFC 0014 Фаза 2: результат прогона тестов → в стор + тост по завершении
      window.api.on.testResult((r) => {
        set((st) => ({ testResults: { ...st.testResults, [r.cwd]: r } }))
        if (!r.running) {
          if (r.error) get().pushToast('error', `Тесты: ${r.error}`)
          else if (r.ok) get().pushToast('info', `✅ Тесты прошли (${r.command})`)
          else get().pushToast('error', `❌ Тесты упали (код ${r.code ?? '?'}, ${r.command})`)
        }
      })
      window.api.on.toast((kind, text) => get().pushToast(kind, text))
      // авто-переименование шелл-сессии, когда в ней запустили CLI (split → claude и т.п.)
      window.api.on.cliDetected((id, agentId, name) => get().applyDetectedCli(id, agentId, name))
      // RFC 0011: в папке воркспейса что-то изменилось → обновить список «Изменения»
      // (дебаунс ~400мс, чтобы не дёргать git status на каждую правку файла).
      window.api.on.fsChanged((root) => {
        const ws = get().workspaces.find((w) => w.folder === root)
        if (!ws) return
        clearTimeout(changedDebounce[ws.id])
        changedDebounce[ws.id] = setTimeout(() => get().refreshChangedFiles(ws.id), 400)
      })
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
    set((s) => ({
      workspaces: s.workspaces.filter((w) => w.id !== id),
      // Группу НЕ удаляем, даже если она опустела — чтобы можно было снова добавить в неё
      // воркспейс (пустая группа остаётся в сайдбаре с кнопкой «＋»). Удаляется только вручную.
      sessions: s.sessions.filter((x) => x.workspaceId !== id),
      activeWorkspaceId: s.activeWorkspaceId === id ? undefined : s.activeWorkspaceId
    }))
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
    const st = get()
    const ws = st.workspaces.find((w) => w.id === id)
    ws?.sessionIds.forEach(async (sid) => {
      const s = st.sessions.find((x) => x.id === sid)
      if (s && !(await window.api.session.isAlive(sid))) {
        await window.api.session.start(s)
        set((cur) => ({
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
    set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== id),
      workspaces: s.workspaces.map((w) => ({
        ...w,
        sessionIds: w.sessionIds.filter((sid) => sid !== id)
      }))
    }))
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
    set((s) => ({
      selectedFile: f,
      selectedFileByWs: wsId ? { ...s.selectedFileByWs, [wsId]: f } : s.selectedFileByWs
    }))
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
    try {
      const files = await window.api.git.status(folder)
      set((s) => ({ changedFiles: { ...s.changedFiles, [workspaceId]: files } }))
    } catch {
      /* нет ядра (браузер без Tauri) — молча пропускаем */
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
  }
}))
