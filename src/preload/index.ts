import { contextBridge, ipcRenderer } from 'electron'
import type {
  PersistState,
  Agent,
  Session,
  CreateSessionInput,
  SessionStatus,
  WorktreeStats,
  TestResult,
  ChangedFile,
  DiffPair,
  MergeResult
} from '../shared/types'

interface FsEntry {
  name: string
  path: string
  isDir: boolean
}

// Безопасный мост: интерфейс (renderer) общается с системой только через этот API.
const api = {
  state: {
    get: (): Promise<PersistState> => ipcRenderer.invoke('state:get'),
    save: (state: PersistState): Promise<boolean> => ipcRenderer.invoke('state:save', state)
  },
  agents: {
    list: (): Promise<Agent[]> => ipcRenderer.invoke('agents:list')
  },
  dialog: {
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder')
  },
  fs: {
    readDir: (dir: string): Promise<FsEntry[]> => ipcRenderer.invoke('fs:readDir', dir),
    readFile: (path: string): Promise<string> => ipcRenderer.invoke('fs:readFile', path),
    // картинка/файл как data-URL (для превью — вебвью так грузит локальные файлы надёжно)
    readFileDataUrl: (path: string): Promise<string | null> =>
      ipcRenderer.invoke('fs:readFileDataUrl', path),
    resolve: (cwd: string, reference: string): Promise<string> =>
      ipcRenderer.invoke('fs:resolve', cwd, reference),
    writeFile: (path: string, content: string): Promise<boolean> =>
      ipcRenderer.invoke('fs:writeFile', path, content),
    rename: (path: string, newName: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('fs:rename', path, newName),
    duplicate: (path: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('fs:duplicate', path),
    trash: (path: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:trash', path),
    reveal: (path: string): Promise<boolean> => ipcRenderer.invoke('fs:reveal', path),
    saveImageBytes: (b64: string, ext: string): Promise<string> =>
      ipcRenderer.invoke('fs:saveImageBytes', b64, ext),
    // живое дерево: начать/перестать следить за папкой (реализовано в Tauri-ядре; Electron — запасной)
    watch: (path: string): void => ipcRenderer.send('fs:watch', path),
    unwatch: (): void => ipcRenderer.send('fs:unwatch')
  },
  clipboard: {
    write: (text: string): Promise<boolean> => ipcRenderer.invoke('clipboard:write', text),
    // пути файлов/папок из буфера (реализовано в Tauri-ядре; Electron — запасной)
    filePaths: (): Promise<string[]> => ipcRenderer.invoke('clipboard:filePaths')
  },
  git: {
    isRepo: (folder: string): Promise<boolean> => ipcRenderer.invoke('git:isRepo', folder),
    worktrees: (folder: string) => ipcRenderer.invoke('git:worktrees', folder),
    branch: (folder: string): Promise<string | null> => ipcRenderer.invoke('git:branch', folder),
    // какие файлы агент тронул + diff по файлу (реализовано в Tauri-ядре; Electron — запасной)
    status: (folder: string): Promise<ChangedFile[]> => ipcRenderer.invoke('git:status', folder),
    diffFile: (folder: string, path: string): Promise<DiffPair> =>
      ipcRenderer.invoke('git:diffFile', folder, path),
    // RFC 0011 A1: не-git папка слишком велика для надёжного снимок-diff? → мягкая подсказка
    diffFolderOversized: (folder: string): Promise<boolean> =>
      ipcRenderer.invoke('git:diffFolderOversized', folder)
  },
  // RFC 0013 — перенос правок агента (merge-back) в основное дерево (реализовано в Tauri-ядре)
  merge: {
    applyFiles: (worktree: string, cloneOf: string, paths: string[]): Promise<MergeResult> =>
      ipcRenderer.invoke('merge:applyFiles', worktree, cloneOf, paths),
    undo: (cloneOf: string, backupSha: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('merge:undo', cloneOf, backupSha)
  },
  // GitHub через gh CLI (полноценно реализовано в Tauri-ядре; Electron — запасной, не подключён)
  github: {
    status: (): Promise<{ installed: boolean; authed: boolean; user?: string }> =>
      ipcRenderer.invoke('github:status'),
    repos: (): Promise<{ nameWithOwner: string; description: string; private: boolean }[]> =>
      ipcRenderer.invoke('github:repos'),
    clone: (repo: string, dest: string): Promise<string> =>
      ipcRenderer.invoke('github:clone', repo, dest)
  },
  session: {
    create: (input: CreateSessionInput): Promise<Session> =>
      ipcRenderer.invoke('session:create', input),
    start: (s: Session): Promise<boolean> => ipcRenderer.invoke('session:start', s),
    restart: (s: Session): Promise<boolean> => ipcRenderer.invoke('session:restart', s),
    isAlive: (id: string): Promise<boolean> => ipcRenderer.invoke('session:isAlive', id),
    setActive: (id: string | null): void => ipcRenderer.send('session:setActive', id),
    userTyped: (id: string): void => ipcRenderer.send('session:userTyped', id)
  },
  pty: {
    write: (sessionId: string, data: string): void =>
      ipcRenderer.send('pty:write', { sessionId, data }),
    resize: (sessionId: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', { sessionId, cols, rows }),
    kill: (sessionId: string): void => ipcRenderer.send('pty:kill', sessionId),
    killAll: (): Promise<void> => ipcRenderer.invoke('pty:killAll'),
    buffer: (sessionId: string): Promise<string> => ipcRenderer.invoke('pty:buffer', sessionId)
  },
  // RFC 0012 (watchdog): статистика «своих веток» + уборка с диска
  worktree: {
    stats: (): Promise<WorktreeStats> => ipcRenderer.invoke('worktree:stats'),
    remove: (path: string, repo: string | null): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('worktree:remove', path, repo)
  },
  // RFC 0014 Фаза 2: прогон тестов проекта (результат — событием test:result)
  tests: {
    run: (cwd: string): void => ipcRenderer.send('tests:run', cwd)
  },
  on: {
    ptyData: (cb: (sessionId: string, data: string) => void) => {
      const h = (_e: unknown, p: { sessionId: string; data: string }) => cb(p.sessionId, p.data)
      ipcRenderer.on('pty:data', h)
      return () => ipcRenderer.removeListener('pty:data', h)
    },
    ptyStatus: (cb: (sessionId: string, status: SessionStatus) => void) => {
      const h = (_e: unknown, p: { sessionId: string; status: SessionStatus }) =>
        cb(p.sessionId, p.status)
      ipcRenderer.on('pty:status', h)
      return () => ipcRenderer.removeListener('pty:status', h)
    },
    ptyExit: (cb: (sessionId: string, code: number) => void) => {
      const h = (_e: unknown, p: { sessionId: string; code: number }) => cb(p.sessionId, p.code)
      ipcRenderer.on('pty:exit', h)
      return () => ipcRenderer.removeListener('pty:exit', h)
    },
    // RFC 0012 watchdog: агент завис/зациклился (мягкий сигнал)
    ptyStalled: (cb: (sessionId: string, stalled: boolean) => void) => {
      const h = (_e: unknown, p: { sessionId: string; stalled: boolean }) => cb(p.sessionId, p.stalled)
      ipcRenderer.on('pty:stalled', h)
      return () => ipcRenderer.removeListener('pty:stalled', h)
    },
    // RFC 0014 Фаза 2: результат прогона тестов
    testResult: (cb: (r: TestResult) => void) => {
      const h = (_e: unknown, p: TestResult) => cb(p)
      ipcRenderer.on('test:result', h)
      return () => ipcRenderer.removeListener('test:result', h)
    },
    toast: (cb: (kind: string, text: string) => void) => {
      const h = (_e: unknown, p: { kind: string; text: string }) => cb(p.kind, p.text)
      ipcRenderer.on('toast', h)
      return () => ipcRenderer.removeListener('toast', h)
    },
    // живое дерево: ядро сообщает, что в папке `root` что-то изменилось
    fsChanged: (cb: (root: string) => void) => {
      const h = (_e: unknown, p: { root: string }) => cb(p.root)
      ipcRenderer.on('fs:changed', h)
      return () => ipcRenderer.removeListener('fs:changed', h)
    },
    // ядро определило, какой CLI запустили в шелл-сессии (split) → переименовать окно
    cliDetected: (cb: (sessionId: string, agentId: string, name: string) => void) => {
      const h = (_e: unknown, p: { sessionId: string; agentId: string; name: string }) =>
        cb(p.sessionId, p.agentId, p.name)
      ipcRenderer.on('session:cli-detected', h)
      return () => ipcRenderer.removeListener('session:cli-detected', h)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type DeckApi = typeof api
