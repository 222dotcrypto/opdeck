import { ipcMain, dialog, BrowserWindow, Notification, shell, clipboard } from 'electron'
import {
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  renameSync,
  cpSync,
  existsSync
} from 'fs'
import { join, dirname, basename, extname } from 'path'
import { randomUUID } from 'crypto'
import { createServer } from 'http'
import { createReadStream } from 'fs'
import { ptyManager } from './pty'
import { detectAgents, AGENTS } from './agents'
import { getState, saveState } from './store'
import { isGitRepo, createWorktree, listWorktrees, currentBranch } from './git'
import type {
  CreateSessionInput,
  Session,
  SessionStatus,
  PersistState,
  BuiltinAgentId
} from '../shared/types'

let getWindow: () => BrowserWindow | null = () => null
const prevStatus = new Map<string, SessionStatus>()
const sessionTitles = new Map<string, string>()

// Безопасная отправка в окно: окно могло закрыться/перезагрузиться (HMR),
// тогда webContents.send бросает «Object has been destroyed». Проверяем живость.
function sendToWindow(channel: string, payload: unknown): void {
  const win = getWindow()
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

// Имя и команда запуска для агента: встроенный или свой CLI из состояния.
// resume=true → для Claude Code продолжить последний разговор в этой папке (--continue).
function resolveAgent(agentId: string, resume = false): { name: string; commandLine?: string } {
  const builtin = AGENTS[agentId as BuiltinAgentId]
  if (builtin) {
    if (builtin.id === 'shell' || !builtin.command) return { name: builtin.name }
    let cmd = [builtin.command, ...builtin.args].join(' ')
    if (resume && builtin.id === 'claude') cmd = 'claude --continue'
    return { name: builtin.name, commandLine: cmd }
  }
  const custom = getState().customAgents.find((c) => c.id === agentId)
  if (custom) return { name: custom.name, commandLine: custom.command }
  return { name: agentId }
}

export function registerIpc(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter

  // PTY → интерфейс
  ptyManager.onData = (sessionId, data) => {
    sendToWindow('pty:data', { sessionId, data })
  }
  ptyManager.onStatus = (sessionId, status) => {
    const prev = prevStatus.get(sessionId)
    prevStatus.set(sessionId, status)
    sendToWindow('pty:status', { sessionId, status })
    // Уведомление, когда агент закончил работу (работал → готов).
    if (prev === 'working' && status === 'ready') {
      const st = getState()
      if (st.settings.notifyOnDone && Notification.isSupported()) {
        const title = sessionTitles.get(sessionId) || 'Агент'
        new Notification({ title: `✅ ${title}`, body: 'Готов / ждёт вас', silent: !st.settings.soundOnDone }).show()
      }
    }
  }
  ptyManager.onExit = (sessionId, code) => {
    sendToWindow('pty:exit', { sessionId, code })
  }

  // ── Состояние ──
  ipcMain.handle('state:get', () => getState())
  ipcMain.handle('state:save', (_e, state: PersistState) => {
    saveState(state)
    for (const s of state.sessions) sessionTitles.set(s.id, s.title)
    return true
  })

  // ── Агенты ── (встроенные + свои CLI пользователя)
  ipcMain.handle('agents:list', () => [
    ...detectAgents(),
    ...getState().customAgents.map((c) => ({
      id: c.id,
      name: c.name,
      command: c.command,
      args: [],
      available: true,
      custom: true
    }))
  ])

  // ── Диалог выбора папки ──
  ipcMain.handle('dialog:pickFolder', async () => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  // ── Файловая система ──
  ipcMain.handle('fs:readDir', (_e, dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => !d.name.startsWith('.git'))
        .map((d) => ({ name: d.name, path: join(dir, d.name), isDir: d.isDirectory() }))
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    } catch {
      return []
    }
  })
  ipcMain.handle('fs:readFile', (_e, path: string) => {
    try {
      const st = statSync(path)
      if (st.size > 2_000_000) return '// файл слишком большой для предпросмотра'
      return readFileSync(path, 'utf-8')
    } catch (e) {
      return `// не удалось открыть файл: ${e}`
    }
  })
  ipcMain.handle('debug:log', (_e, msg: string) => {
    try {
      writeFileSync('/tmp/deck-debug.log', msg + '\n', { flag: 'a' })
    } catch {
      /* no-op */
    }
  })
  // Локальный веб-сервер: отдаёт файлы по http://127.0.0.1:PORT/<путь> для Браузера.
  let localPort = 0
  ipcMain.handle('http:port', async () => {
    if (localPort) return localPort
    const MIME: Record<string, string> = {
      html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
      css: 'text/css; charset=utf-8', js: 'application/javascript; charset=utf-8',
      mjs: 'application/javascript; charset=utf-8', jsx: 'application/javascript; charset=utf-8',
      json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png',
      jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
      ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf'
    }
    const srv = createServer((req, res) => {
      try {
        const p = decodeURI((req.url || '').split('?')[0])
        if (!existsSync(p) || statSync(p).isDirectory()) {
          res.statusCode = 404
          res.end('not found')
          return
        }
        res.setHeader('Content-Type', MIME[extname(p).slice(1).toLowerCase()] || 'application/octet-stream')
        createReadStream(p).pipe(res)
      } catch {
        res.statusCode = 500
        res.end('error')
      }
    })
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const addr = srv.address()
    localPort = typeof addr === 'object' && addr ? addr.port : 0
    return localPort
  })
  ipcMain.handle('fs:readFileDataUrl', (_e, path: string) => {
    try {
      const st = statSync(path)
      if (st.size > 10_000_000) return null
      const ext = extname(path).slice(1).toLowerCase()
      const mime =
        ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext || 'png'}`
      return `data:${mime};base64,${readFileSync(path).toString('base64')}`
    } catch {
      return null
    }
  })
  ipcMain.handle('fs:resolve', (_e, cwd: string, reference: string) => {
    const clean = reference.replace(/^\.\//, '')
    const abs = clean.startsWith('/') ? clean : join(cwd, clean)
    if (existsSync(abs)) return abs
    const name = basename(clean)
    const find = (dir: string, depth: number): string | null => {
      if (depth > 6) return null
      let items: string[]
      try {
        items = readdirSync(dir)
      } catch {
        return null
      }
      const subdirs: string[] = []
      for (const it of items) {
        if (it.startsWith('.') || ['node_modules', 'target', 'dist', 'dist-web', 'out'].includes(it)) continue
        const p = join(dir, it)
        try {
          const st = statSync(p)
          if (st.isFile() && it === name) return p
          if (st.isDirectory()) subdirs.push(p)
        } catch {
          /* skip */
        }
      }
      for (const d of subdirs) {
        const f = find(d, depth + 1)
        if (f) return f
      }
      return null
    }
    return name ? find(cwd, 0) ?? abs : abs
  })
  ipcMain.handle('fs:writeFile', (_e, path: string, content: string) => {
    try {
      writeFileSync(path, content, 'utf-8')
      return true
    } catch (e) {
      sendToWindow('toast', { kind: 'error', text: `Не сохранилось: ${e}` })
      return false
    }
  })
  // Переименование: newName — только имя, файл остаётся в своей папке.
  ipcMain.handle('fs:rename', (_e, path: string, newName: string) => {
    const next = join(dirname(path), newName)
    if (existsSync(next)) return { ok: false, error: 'Файл с таким именем уже есть' }
    try {
      renameSync(path, next)
      return { ok: true, path: next }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })
  // Дубликат рядом: «имя копия.ext», при занятости — «имя копия 2.ext» и т.д.
  ipcMain.handle('fs:duplicate', (_e, path: string) => {
    const dir = dirname(path)
    const ext = statSync(path).isDirectory() ? '' : extname(path)
    const stem = basename(path, ext)
    let next = join(dir, `${stem} копия${ext}`)
    let n = 2
    while (existsSync(next)) next = join(dir, `${stem} копия ${n++}${ext}`)
    try {
      cpSync(path, next, { recursive: true })
      return { ok: true, path: next }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })
  // Удаление — в Корзину (восстановимо), не безвозвратно.
  ipcMain.handle('fs:trash', async (_e, path: string) => {
    try {
      await shell.trashItem(path)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })
  ipcMain.handle('fs:reveal', (_e, path: string) => {
    shell.showItemInFolder(path)
    return true
  })
  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(text)
    return true
  })

  // ── Git ──
  ipcMain.handle('git:isRepo', (_e, folder: string) => isGitRepo(folder))
  ipcMain.handle('git:worktrees', (_e, folder: string) => listWorktrees(folder))
  ipcMain.handle('git:branch', (_e, folder: string) => currentBranch(folder))

  // ── Сессии ──
  ipcMain.handle('session:create', async (_e, input: CreateSessionInput): Promise<Session> => {
    const st = getState()
    const ws = st.workspaces.find((w) => w.id === input.workspaceId)
    let cwd = input.cwd || ws?.folder || process.env.HOME || '/'
    let cloneOf: string | undefined
    let branch: string | undefined

    const spec = resolveAgent(input.agentId)

    if (input.clone) {
      if (await isGitRepo(cwd)) {
        const wt = await createWorktree(cwd, spec.name)
        cloneOf = cwd
        cwd = wt.path
        branch = wt.branch
      } else {
        // не git-репозиторий — клон невозможен, работаем в исходной папке
        sendToWindow('toast', {
          kind: 'warn',
          text: 'Своя ветка возможна только для git-репозитория — открыл в исходной папке'
        })
      }
    }

    const title =
      input.title || (input.firstPrompt ? input.firstPrompt.slice(0, 32) : spec.name)

    const session: Session = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      title,
      cwd,
      cloneOf,
      branch,
      status: 'working',
      firstPrompt: input.firstPrompt,
      createdAt: Date.now(),
      alive: true
    }
    sessionTitles.set(session.id, title)
    prevStatus.set(session.id, 'working')

    ptyManager.spawn({
      sessionId: session.id,
      commandLine: spec.commandLine,
      cwd,
      firstPrompt: input.firstPrompt
    })
    return session
  })

  // Запуск PTY для уже существующей сессии (после перезапуска приложения).
  // Claude Code продолжит последний разговор в этой папке (--continue).
  ipcMain.handle('session:start', (_e, s: Session) => {
    sessionTitles.set(s.id, s.title)
    const spec = resolveAgent(s.agentId, true)
    ptyManager.spawn({ sessionId: s.id, commandLine: spec.commandLine, cwd: s.cwd })
    return true
  })

  ipcMain.handle('session:isAlive', (_e, sessionId: string) => ptyManager.isAlive(sessionId))
  ipcMain.handle('pty:buffer', (_e, sessionId: string) => ptyManager.getBuffer(sessionId))

  ipcMain.on('pty:write', (_e, { sessionId, data }: { sessionId: string; data: string }) =>
    ptyManager.write(sessionId, data)
  )
  ipcMain.on('pty:resize', (_e, { sessionId, cols, rows }: { sessionId: string; cols: number; rows: number }) =>
    ptyManager.resize(sessionId, cols, rows)
  )
  ipcMain.on('pty:kill', (_e, sessionId: string) => ptyManager.kill(sessionId))
}
