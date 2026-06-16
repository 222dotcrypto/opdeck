import * as pty from 'node-pty'
import type { SessionStatus } from '../shared/types'

// Менеджер псевдо-терминалов (PTY). Запускает CLI-агентов в настоящих
// терминалах, стримит вывод в интерфейс и отслеживает статус по активности.

interface Live {
  proc: pty.IPty
  status: SessionStatus
  idleTimer: NodeJS.Timeout | null
  firstPrompt?: string
  firstPromptSent: boolean
  booted: boolean
  buffer: string // накопленный вывод терминала (для восстановления при переключении)
}

const BUFFER_CAP = 250_000 // макс. символов истории на сессию

type DataCb = (sessionId: string, data: string) => void
type StatusCb = (sessionId: string, status: SessionStatus) => void
type ExitCb = (sessionId: string, code: number) => void

const IDLE_MS = 700 // тишина дольше этого = агент закончил/ждёт

export class PtyManager {
  private map = new Map<string, Live>()
  onData: DataCb = () => {}
  onStatus: StatusCb = () => {}
  onExit: ExitCb = () => {}

  spawn(opts: {
    sessionId: string
    commandLine?: string // готовая команда запуска (например "claude" или "claude --continue"); пусто = просто оболочка
    cwd: string
    cols?: number
    rows?: number
    firstPrompt?: string
  }): void {
    if (this.map.has(opts.sessionId)) return // уже запущен

    const shell = process.env.SHELL || '/bin/zsh'

    // Запуск через login-shell, чтобы подхватился полный PATH (nvm, brew).
    // Для агента — exec, чтобы PTY стал самим агентом. Для shell — обычный zsh.
    let file: string
    let args: string[]
    if (!opts.commandLine) {
      file = shell
      args = ['-l']
    } else {
      file = shell
      args = ['-lic', `exec ${opts.commandLine}`]
    }

    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        DECK_SESSION_ID: opts.sessionId
      } as { [key: string]: string }
    })

    const live: Live = {
      proc,
      status: 'working',
      idleTimer: null,
      firstPrompt: opts.firstPrompt,
      firstPromptSent: false,
      booted: false,
      buffer: ''
    }
    this.map.set(opts.sessionId, live)
    this.setStatus(opts.sessionId, 'working')

    proc.onData((data) => {
      // копим историю (с ограничением сверху)
      live.buffer += data
      if (live.buffer.length > BUFFER_CAP) live.buffer = live.buffer.slice(-BUFFER_CAP)
      this.onData(opts.sessionId, data)
      this.setStatus(opts.sessionId, 'working')
      this.armIdle(opts.sessionId)
    })

    proc.onExit(({ exitCode }) => {
      const l = this.map.get(opts.sessionId)
      if (l?.idleTimer) clearTimeout(l.idleTimer)
      this.map.delete(opts.sessionId)
      this.onExit(opts.sessionId, exitCode)
      this.onStatus(opts.sessionId, exitCode === 0 ? 'idle' : 'error')
    })
  }

  private armIdle(sessionId: string): void {
    const live = this.map.get(sessionId)
    if (!live) return
    if (live.idleTimer) clearTimeout(live.idleTimer)
    live.idleTimer = setTimeout(() => {
      live.booted = true
      this.setStatus(sessionId, 'ready')
      // Первый промт отправляем, когда агент впервые «успокоился» (готов к вводу).
      if (live.firstPrompt && !live.firstPromptSent) {
        live.firstPromptSent = true
        setTimeout(() => this.write(sessionId, live.firstPrompt + '\r'), 150)
      }
    }, IDLE_MS)
  }

  private setStatus(sessionId: string, status: SessionStatus): void {
    const live = this.map.get(sessionId)
    if (!live) return
    if (live.status === status) return
    live.status = status
    this.onStatus(sessionId, status)
  }

  write(sessionId: string, data: string): void {
    this.map.get(sessionId)?.proc.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const live = this.map.get(sessionId)
    if (live && cols > 0 && rows > 0) {
      try {
        live.proc.resize(cols, rows)
      } catch {
        /* окно закрыто — игнор */
      }
    }
  }

  kill(sessionId: string): void {
    const live = this.map.get(sessionId)
    if (live) {
      if (live.idleTimer) clearTimeout(live.idleTimer)
      try {
        live.proc.kill()
      } catch {
        /* уже мёртв */
      }
      this.map.delete(sessionId)
    }
  }

  isAlive(sessionId: string): boolean {
    return this.map.has(sessionId)
  }

  // Накопленный вывод терминала — чтобы при повторном показе панели
  // восстановить то, что было на экране (для любого агента).
  getBuffer(sessionId: string): string {
    return this.map.get(sessionId)?.buffer ?? ''
  }

  killAll(): void {
    for (const id of [...this.map.keys()]) this.kill(id)
  }
}

export const ptyManager = new PtyManager()
