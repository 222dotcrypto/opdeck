// Общие типы для главного процесса (main), моста (preload) и интерфейса (renderer).

export type BuiltinAgentId =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'qwen'
  | 'grok'
  | 'opencode'
  | 'shell'

// id агента: встроенный или свой CLI пользователя (custom:<uuid>)
export type AgentId = string

// Свой CLI, добавленный пользователем (название + команда запуска).
export interface CustomAgent {
  id: string
  name: string
  command: string
}

// Пресет воркспейса: раскладка + какие агенты в окнах. Имя/папку вводят при создании.
export interface WorkspacePreset {
  id: string
  name: string
  layout: LayoutId
  panels: { agentId: AgentId; clone: boolean }[]
}

// Статус сессии — цвет рамки вокруг терминала.
export type SessionStatus =
  | 'ready'    // зелёный — готов / закончил
  | 'working'  // синий — что-то делает (есть свежий вывод)
  | 'awaiting' // жёлтый — ждёт ответа пользователя
  | 'error'    // красный — процесс упал
  | 'idle'     // серый — ещё не запущен / простаивает

export interface Agent {
  id: AgentId
  name: string
  command: string
  args: string[]
  available?: boolean
  custom?: boolean
}

export interface Session {
  id: string
  workspaceId: string
  agentId: AgentId
  title: string
  cwd: string
  cloneOf?: string // путь к оригинальному репозиторию, если это клон-папка (worktree)
  branch?: string // ветка worktree
  status: SessionStatus
  firstPrompt?: string
  createdAt: number
  alive?: boolean // жив ли PTY-процесс прямо сейчас (runtime)
  shell?: string // оболочка запуска (zsh/bash/…); пусто = системная. Хранится для перезапуска
  extraArgs?: string // доп. флаги к команде агента (напр. --model …). Хранится для перезапуска
  resumeId?: string // RFC 0007: нативный resume-id агента (round-trip через стейт)
  stalled?: boolean // RFC 0012: watchdog заметил зацикливание (мягкий флаг, runtime)
}

// RFC 0012 (watchdog): статистика «своих веток» (worktree).
export interface WorktreeStats {
  count: number // активных Deck-веток
  limit: number // мягкий лимит
  overLimit: boolean
  diskBytes: number // занято в ~/.deck-worktrees
  diskWarnGb: number
  diskWarn: boolean
}

// RFC 0014 Фаза 2: результат прогона тестов (приходит событием test:result).
export interface TestResult {
  cwd: string
  running: boolean
  ok?: boolean
  code?: number
  command?: string
  output?: string
  error?: string
}

export interface Workspace {
  id: string
  name: string
  folder: string
  groupId?: string
  layout: LayoutId
  sessionIds: string[]
  gridCols?: number // ручная раскладка: число столбцов (undefined = авто)
}

export type LayoutId = '1' | '2v' | '2h' | '3' | '4' | '2x2' | '1x3' | '2x3' | '2x4'

export interface Group {
  id: string
  name: string
  color: string
  collapsed?: boolean
}

export interface Settings {
  soundOnDone: boolean
  notifyOnDone: boolean
  defaultShell: string
  // RFC 0015: «режим доверия» CLI для Deck-сессий (пусто = нативный дефолт CLI)
  claudePermissionMode?: string
  codexApproval?: string
  codexSandbox?: string
}

// RFC 0016 — задача беклога. Тег (kind) и цикл (status) предопределены.
// attachments — пути к файлам-скринам (save_image_bytes), не base64.
export type BacklogKind = 'bug' | 'idea' | 'feature'
export type BacklogStatus = 'draft' | 'sent' | 'done'

export interface BacklogTask {
  id: string
  title: string
  description: string
  kind: BacklogKind
  attachments: string[] // абсолютные пути к файлам-скринам
  status: BacklogStatus
  createdAt: string // ISO-строка
  sentSessionId?: string // RFC 0016: какой сессии отдали (аудит, разовая отправка)
}

export interface PersistState {
  groups: Group[]
  workspaces: Workspace[]
  sessions: Session[]
  settings: Settings
  customAgents: CustomAgent[]
  presets: WorkspacePreset[]
  tasks?: BacklogTask[] // RFC 0016 — беклог задач
  activeWorkspaceId?: string
}

// Параметры создания сессии (из мастера и из вкладки-сводки).
export interface CreateSessionInput {
  workspaceId: string
  agentId: AgentId
  cwd?: string // если не задано — берётся папка воркспейса
  clone?: boolean // сделать клон-папку (git worktree)
  firstPrompt?: string
  title?: string
  shell?: string // оболочка запуска (zsh/bash/…); пусто = системная
  extraArgs?: string // доп. флаги к команде агента (напр. --model gpt-5)
}

export const GROUP_COLORS = [
  '#3fb950', '#d29922', '#a371f7', '#58a6ff', '#f85149', '#ec6cb9', '#39c5cf'
]

// Файл, который агент тронул в папке (для списка «Изменения» и пометки в дереве).
// path — относительно корня репозитория.
export interface ChangedFile {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
}

// Пара текстов «было → стало» для Monaco DiffEditor.
export interface DiffPair {
  oldText: string
  newText: string
  status: string
}

// RFC 0013 — результат переноса (merge-back) в основное дерево. ok=false + conflicts ⇒
// основное НЕ тронуто. backupSha — точка отката (есть только при ok). error — текст ошибки.
export interface MergeResult {
  ok: boolean
  appliedFiles: number
  backupSha?: string
  conflicts: string[]
  error?: string
}
