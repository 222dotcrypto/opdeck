import { app } from 'electron'
import { join, dirname } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import type { PersistState } from '../shared/types'

// Простое хранилище состояния в JSON-файле внутри userData.
// Хранит метаданные (воркспейсы, группы, сессии, настройки).
// Живые PTY-процессы тут НЕ хранятся — они существуют только во время работы.

const DEFAULT_STATE: PersistState = {
  groups: [],
  workspaces: [],
  sessions: [],
  settings: { soundOnDone: true, notifyOnDone: true, defaultShell: '/bin/zsh' },
  customAgents: [],
  presets: []
}

let statePath = ''
let cache: PersistState | null = null
let saveTimer: NodeJS.Timeout | null = null

function ensurePath(): string {
  if (!statePath) {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    statePath = join(dir, 'deck-state.json')
  }
  return statePath
}

// Старый файл (имя Pult) — для разовой миграции воркспейсов.
function legacyPath(): string {
  return join(dirname(app.getPath('userData')), 'pult', 'pilotry-state.json')
}

export function loadState(): PersistState {
  if (cache) return cache
  const p = ensurePath()
  const src = existsSync(p) ? p : existsSync(legacyPath()) ? legacyPath() : null
  if (src) {
    try {
      const raw = JSON.parse(readFileSync(src, 'utf-8'))
      cache = { ...DEFAULT_STATE, ...raw, settings: { ...DEFAULT_STATE.settings, ...raw.settings } }
    } catch {
      cache = structuredClone(DEFAULT_STATE)
    }
  } else {
    cache = structuredClone(DEFAULT_STATE)
  }
  return cache!
}

export function saveState(next: PersistState): void {
  cache = next
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      writeFileSync(ensurePath(), JSON.stringify(cache, null, 2), 'utf-8')
    } catch (e) {
      console.error('saveState failed', e)
    }
  }, 250)
}

export function getState(): PersistState {
  return loadState()
}

// Немедленная запись на диск (на выходе приложения) — чтобы не потерять
// изменения, которые ещё ждут в debounce-таймере.
export function flushState(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (cache) {
    try {
      writeFileSync(ensurePath(), JSON.stringify(cache, null, 2), 'utf-8')
    } catch (e) {
      console.error('flushState failed', e)
    }
  }
}
