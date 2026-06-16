import { useMemo, useState } from 'react'
import { useStore } from '../store'
import CustomCliForm from './CustomCliForm'

interface Props {
  workspaceId: string
  defaultFolder: string
  onDone: () => void
}

export default function AddSessionForm({ workspaceId, defaultFolder, onDone }: Props): JSX.Element {
  const agents = useStore((s) => s.agents)
  const customAgents = useStore((s) => s.customAgents)
  const createSession = useStore((s) => s.createSession)

  const pickable = useMemo(
    () => [
      ...agents.filter((a) => a.available && !a.custom),
      ...customAgents.map((c) => ({ id: c.id, name: c.name, custom: true }))
    ],
    [agents, customAgents]
  )

  const [agentId, setAgentId] = useState<string>(pickable[0]?.id ?? 'shell')
  const [folder, setFolder] = useState(defaultFolder)
  const [clone, setClone] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [shell, setShell] = useState('')
  const [extraArgs, setExtraArgs] = useState('')
  const [busy, setBusy] = useState(false)
  const [showCliForm, setShowCliForm] = useState(false)

  const pick = async (): Promise<void> => {
    const f = await window.api.dialog.pickFolder()
    if (f) setFolder(f)
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    await createSession({
      workspaceId,
      agentId,
      cwd: folder,
      clone,
      shell: shell || undefined,
      extraArgs: extraArgs.trim() || undefined,
      firstPrompt: prompt.trim() || undefined
    })
    setBusy(false)
    onDone()
  }

  return (
    <div className="addform">
      <div className="nw-section-row tight">
        <label className="af-label">CLI-агент</label>
        <button className="link-btn" onClick={() => setShowCliForm((v) => !v)}>
          ＋ свой CLI
        </button>
      </div>
      {showCliForm && <CustomCliForm onDone={() => setShowCliForm(false)} />}
      <div className="af-agents">
        {pickable.map((a) => (
          <button
            key={a.id}
            className={`af-agent ${agentId === a.id ? 'sel' : ''}`}
            onClick={() => setAgentId(a.id)}
          >
            {a.name}
          </button>
        ))}
      </div>

      <label className="af-label">Папка</label>
      <div className="af-folder">
        <input value={folder} onChange={(e) => setFolder(e.target.value)} />
        <button onClick={pick}>Выбрать…</button>
      </div>

      <label
        className="af-check"
        title="git worktree: агент получает отдельную копию кода в своей ветке, потом сливаешь в основную"
      >
        <input type="checkbox" checked={clone} onChange={(e) => setClone(e.target.checked)} />
        <span>Своя ветка — отдельная копия кода для этого агента</span>
      </label>

      <div className="nw-grid">
        <div className="nw-field">
          <label>Оболочка</label>
          <select value={shell} onChange={(e) => setShell(e.target.value)}>
            <option value="">Системная</option>
            <option value="/bin/zsh">zsh</option>
            <option value="/bin/bash">bash</option>
            <option value="/bin/sh">sh</option>
          </select>
        </div>
        <div className="nw-field">
          <label>Доп. флаги агента</label>
          <input
            value={extraArgs}
            onChange={(e) => setExtraArgs(e.target.value)}
            placeholder="напр. --model gpt-5"
          />
        </div>
      </div>

      <label className="af-label">Первый промт (необязательно)</label>
      <textarea className="af-prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />

      <div className="af-actions">
        <button className="btn-ghost" onClick={onDone} disabled={busy}>
          Отмена
        </button>
        <button className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Создаю…' : 'Создать и запустить'}
        </button>
      </div>
    </div>
  )
}
