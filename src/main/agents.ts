import { execSync } from 'child_process'
import type { Agent, BuiltinAgentId } from '../shared/types'

// Каталог встроенных CLI-агентов. command — имя бинарника в PATH.
// Свои CLI пользователя хранятся в состоянии (customAgents) и
// объединяются со встроенными в ipc.
export const AGENTS: Record<BuiltinAgentId, Agent> = {
  claude: { id: 'claude', name: 'Claude Code', command: 'claude', args: [] },
  codex: { id: 'codex', name: 'Codex', command: 'codex', args: [] },
  gemini: { id: 'gemini', name: 'Gemini', command: 'gemini', args: [] },
  qwen: { id: 'qwen', name: 'Qwen', command: 'qwen', args: [] },
  grok: { id: 'grok', name: 'Grok', command: 'grok', args: [] },
  opencode: { id: 'opencode', name: 'opencode', command: 'opencode', args: [] },
  shell: { id: 'shell', name: 'Shell', command: '', args: [] }
}

// Кэш доступности: проверяем, что бинарник реально есть в системе.
let availabilityCache: Record<string, boolean> | null = null

export function detectAgents(): Agent[] {
  if (!availabilityCache) {
    availabilityCache = {}
    for (const a of Object.values(AGENTS)) {
      if (a.id === 'shell') {
        availabilityCache[a.id] = true
        continue
      }
      try {
        // login shell, чтобы подхватить PATH из ~/.zshrc (nvm, brew и т.п.)
        execSync(`/bin/zsh -lic 'command -v ${a.command}'`, {
          stdio: 'ignore',
          timeout: 4000
        })
        availabilityCache[a.id] = true
      } catch {
        availabilityCache[a.id] = false
      }
    }
  }
  return Object.values(AGENTS).map((a) => ({ ...a, available: availabilityCache![a.id] }))
}
