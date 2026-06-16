// Мост к Tauri: реализует тот же интерфейс window.api, что и Electron-preload,
// но через команды/события Tauri. Компоненты при этом не меняются.
// Устанавливается только когда приложение запущено под Tauri.
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
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
} from '../../shared/types'

interface FsEntry {
  name: string
  path: string
  isDir: boolean
}

// listen() в Tauri асинхронный, а компонентам нужна синхронная функция отписки.
// Оборачиваем: возвращаем функцию, которая отпишется, как только listen разрешится.
function sub<T>(event: string, handler: (payload: T) => void): () => void {
  let un: UnlistenFn | null = null
  let cancelled = false
  listen<T>(event, (e) => handler(e.payload))
    .then((u) => {
      if (cancelled) u()
      else un = u
    })
    .catch(() => {
      /* нет среды Tauri (напр. открыто в браузере) — событий не будет */
    })
  return () => {
    cancelled = true
    un?.()
  }
}

export function installTauriBridge(): void {
  const api = {
    state: {
      get: (): Promise<PersistState> => invoke('state_get'),
      save: (state: PersistState): Promise<boolean> => invoke('state_save', { state })
    },
    agents: {
      list: (): Promise<Agent[]> => invoke('agents_list')
    },
    dialog: {
      pickFolder: async (): Promise<string | null> => {
        const res = await open({ directory: true, multiple: false })
        return typeof res === 'string' ? res : null
      }
    },
    fs: {
      readDir: (dir: string): Promise<FsEntry[]> => invoke('fs_read_dir', { dir }),
      readFile: (path: string): Promise<string> => invoke('fs_read_file', { path }),
      readFileDataUrl: (path: string): Promise<string | null> =>
        invoke('fs_read_file_data_url', { path }),
      resolve: (cwd: string, reference: string): Promise<string> =>
        invoke('fs_resolve', { cwd, reference }),
      writeFile: (path: string, content: string): Promise<boolean> =>
        invoke('fs_write_file', { path, content }),
      rename: (path: string, newName: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
        invoke('fs_rename', { path, newName }),
      duplicate: (path: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
        invoke('fs_duplicate', { path }),
      trash: (path: string): Promise<{ ok: boolean; error?: string }> => invoke('fs_trash', { path }),
      reveal: (path: string): Promise<boolean> => invoke('fs_reveal', { path }),
      saveImageBytes: (b64: string, ext: string): Promise<string> =>
        invoke('save_image_bytes', { b64, ext }),
      // живое дерево: начать/перестать следить за папкой воркспейса
      watch: (path: string): void => {
        invoke('fs_watch', { path })
      },
      unwatch: (): void => {
        invoke('fs_unwatch')
      }
    },
    clipboard: {
      write: async (text: string): Promise<boolean> => {
        await writeText(text)
        return true
      },
      filePaths: (): Promise<string[]> => invoke('clipboard_file_paths')
    },
    git: {
      isRepo: (folder: string): Promise<boolean> => invoke('git_is_repo', { folder }),
      worktrees: (folder: string) => invoke('git_worktrees', { folder }),
      branch: (folder: string): Promise<string | null> => invoke('git_branch', { folder }),
      // какие файлы агент тронул в папке
      status: (folder: string): Promise<ChangedFile[]> => invoke('git_status', { folder }),
      // diff «было → стало» по одному файлу (путь относительно корня репо)
      diffFile: (folder: string, path: string): Promise<DiffPair> =>
        invoke('git_diff_file', { folder, path }),
      // RFC 0011 A1: не-git папка слишком велика для надёжного снимок-diff? → мягкая подсказка
      diffFolderOversized: (folder: string): Promise<boolean> =>
        invoke('diff_folder_oversized', { folder })
    },
    // RFC 0013 — перенос правок агента (merge-back) в основное дерево
    merge: {
      // применить выбранные файлы из ветки агента (worktree) в основное дерево (cloneOf).
      // Все гейты безопасности — в ядре; конфликт → ok=false, основное не тронуто.
      applyFiles: (worktree: string, cloneOf: string, paths: string[]): Promise<MergeResult> =>
        invoke('merge_apply_files', { worktree, cloneOf, paths }),
      // откатить перенос к точке backupSha
      undo: (cloneOf: string, backupSha: string): Promise<{ ok: boolean; error?: string }> =>
        invoke('merge_undo', { cloneOf, backupSha })
    },
    github: {
      status: (): Promise<{ installed: boolean; authed: boolean; user?: string }> =>
        invoke('github_status'),
      repos: (): Promise<{ nameWithOwner: string; description: string; private: boolean }[]> =>
        invoke('github_repos'),
      clone: (repo: string, dest: string): Promise<string> => invoke('github_clone', { repo, dest })
    },
    session: {
      create: (input: CreateSessionInput): Promise<Session> => invoke('session_create', { input }),
      start: (s: Session): Promise<boolean> => invoke('session_start', { session: s }),
      // RFC 0012: рестарт зависшей сессии (убить + поднять заново тем же resume-путём)
      restart: (s: Session): Promise<boolean> => invoke('restart_session', { session: s }),
      isAlive: (id: string): Promise<boolean> => invoke('session_is_alive', { id }),
      setActive: (id: string | null): void => {
        invoke('session_set_active', { id })
      },
      userTyped: (id: string): void => {
        invoke('session_user_typed', { id })
      }
    },
    pty: {
      write: (sessionId: string, data: string): void => {
        invoke('pty_write', { sessionId, data })
      },
      resize: (sessionId: string, cols: number, rows: number): void => {
        invoke('pty_resize', { sessionId, cols, rows })
      },
      kill: (sessionId: string): void => {
        invoke('pty_kill', { sessionId })
      },
      // RFC 0012: убить ВСЕ сессии (kill_all + alive=false)
      killAll: (): Promise<void> => invoke('kill_all_sessions'),
      buffer: (sessionId: string): Promise<string> => invoke('pty_buffer', { sessionId })
    },
    // RFC 0012 (watchdog): статистика «своих веток» + уборка с диска
    worktree: {
      stats: (): Promise<WorktreeStats> => invoke('worktree_stats'),
      remove: (path: string, repo: string | null): Promise<{ ok: boolean; error?: string }> =>
        invoke('remove_worktree', { path, repo })
    },
    // RFC 0014 Фаза 2: прогон тестов (результат — событием test:result)
    tests: {
      run: (cwd: string): void => {
        invoke('run_tests', { cwd })
      }
    },
    on: {
      ptyData: (cb: (sessionId: string, data: string) => void) =>
        sub<{ sessionId: string; data: string }>('pty:data', (p) => cb(p.sessionId, p.data)),
      ptyStatus: (cb: (sessionId: string, status: SessionStatus) => void) =>
        sub<{ sessionId: string; status: SessionStatus }>('pty:status', (p) =>
          cb(p.sessionId, p.status)
        ),
      ptyExit: (cb: (sessionId: string, code: number) => void) =>
        sub<{ sessionId: string; code: number }>('pty:exit', (p) => cb(p.sessionId, p.code)),
      // RFC 0012 watchdog: агент завис/зациклился (мягкий сигнал)
      ptyStalled: (cb: (sessionId: string, stalled: boolean) => void) =>
        sub<{ sessionId: string; stalled: boolean }>('pty:stalled', (p) => cb(p.sessionId, p.stalled)),
      // RFC 0014 Фаза 2: результат прогона тестов
      testResult: (cb: (r: TestResult) => void) => sub<TestResult>('test:result', (p) => cb(p)),
      toast: (cb: (kind: string, text: string) => void) =>
        sub<{ kind: string; text: string }>('toast', (p) => cb(p.kind, p.text)),
      // живое дерево: ядро сообщает, что в папке `root` что-то изменилось
      fsChanged: (cb: (root: string) => void) =>
        sub<{ root: string }>('fs:changed', (p) => cb(p.root)),
      // ядро определило, какой CLI запустили в шелл-сессии (split) → переименовать окно
      cliDetected: (cb: (sessionId: string, agentId: string, name: string) => void) =>
        sub<{ sessionId: string; agentId: string; name: string }>('session:cli-detected', (p) =>
          cb(p.sessionId, p.agentId, p.name)
        )
    }
  }
  // @ts-expect-error — ставим тот же глобальный объект, что и Electron-preload
  window.api = api
}

// Запущены ли мы под Tauri
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
