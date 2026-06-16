import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, dirname, basename } from 'path'

const run = promisify(execFile)

// Утилиты git для фичи «клон-папка» (git worktree).
// worktree — официальный механизм git: несколько рабочих копий одного
// репозитория на разных ветках. Агенты работают параллельно каждый в своей
// копии, потом ветки сливаются в main по очереди.

export async function isGitRepo(folder: string): Promise<boolean> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: folder })
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

export async function repoRoot(folder: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd: folder })
    return stdout.trim()
  } catch {
    return null
  }
}

export interface WorktreeResult {
  path: string
  branch: string
}

// Создаёт новую рабочую копию (worktree) для сессии на свежей ветке.
export async function createWorktree(folder: string, label: string): Promise<WorktreeResult> {
  const root = await repoRoot(folder)
  if (!root) throw new Error('Папка не является git-репозиторием')

  const short = Math.random().toString(36).slice(2, 8)
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24) || 'agent'
  const branch = `deck/${safeLabel}-${short}`
  const base = basename(root)
  const wtDir = join(dirname(root), '.deck-worktrees', `${base}-${safeLabel}-${short}`)

  await run('git', ['worktree', 'add', '-b', branch, wtDir], { cwd: root })
  return { path: wtDir, branch }
}

export async function removeWorktree(folder: string, worktreePath: string): Promise<void> {
  const root = (await repoRoot(folder)) ?? folder
  try {
    await run('git', ['worktree', 'remove', '--force', worktreePath], { cwd: root })
  } catch {
    // если уже удалён вручную — чистим запись
    await run('git', ['worktree', 'prune'], { cwd: root }).catch(() => {})
  }
}

export interface WorktreeInfo {
  path: string
  branch: string
}

export async function listWorktrees(folder: string): Promise<WorktreeInfo[]> {
  const root = await repoRoot(folder)
  if (!root) return []
  const { stdout } = await run('git', ['worktree', 'list', '--porcelain'], { cwd: root })
  const out: WorktreeInfo[] = []
  let cur: Partial<WorktreeInfo> = {}
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) cur.path = line.slice(9)
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '')
    else if (line.trim() === '') {
      if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? '(detached)' })
      cur = {}
    }
  }
  if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? '(detached)' })
  return out
}

// Текущая ветка в папке (для отображения).
export async function currentBranch(folder: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: folder })
    return stdout.trim()
  } catch {
    return null
  }
}
