import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { LAYOUTS, layoutDef } from './layouts'
import LayoutThumb from './LayoutThumb'
import CustomCliForm from './CustomCliForm'
import type { AgentId, LayoutId } from '../../../shared/types'

interface PanelCfg {
  agentId: AgentId
  clone: boolean
  shell?: string
  extraArgs?: string
}

export default function NewWorkspaceModal({
  onClose,
  defaultGroupName = ''
}: {
  onClose: () => void
  defaultGroupName?: string
}): JSX.Element {
  const agents = useStore((s) => s.agents)
  const customAgents = useStore((s) => s.customAgents)
  const groups = useStore((s) => s.groups)
  const presets = useStore((s) => s.presets)
  const addGroup = useStore((s) => s.addGroup)
  const addWorkspace = useStore((s) => s.addWorkspace)
  const createSession = useStore((s) => s.createSession)
  const savePreset = useStore((s) => s.savePreset)
  const deletePreset = useStore((s) => s.deletePreset)
  const pushToast = useStore((s) => s.pushToast)

  // выбор агентов: установленные встроенные + свои CLI
  const pickable = useMemo(
    () => [
      ...agents.filter((a) => a.available && !a.custom),
      ...customAgents.map((c) => ({ id: c.id, name: c.name, command: c.command, args: [], available: true, custom: true }))
    ],
    [agents, customAgents]
  )
  const defaultAgent = pickable[0]?.id ?? 'shell'

  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [groupName, setGroupName] = useState(defaultGroupName)
  const [layout, setLayout] = useState<LayoutId>('2v')
  const [panels, setPanels] = useState<PanelCfg[]>(
    Array.from({ length: 2 }, () => ({ agentId: defaultAgent, clone: false }))
  )
  const [busy, setBusy] = useState(false)
  const [showCliForm, setShowCliForm] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [showPresetSave, setShowPresetSave] = useState(false)
  const [activePresetId, setActivePresetId] = useState<string | null>(null)
  // GitHub-клон (необязательно): папка проекта становится родителем для клона
  const [cloneRepo, setCloneRepo] = useState('')
  const [ghRepos, setGhRepos] = useState<{ nameWithOwner: string }[]>([])

  useEffect(() => {
    window.api.github
      .status()
      .then((s) => {
        if (s.authed) window.api.github.repos().then(setGhRepos).catch(() => {})
      })
      .catch(() => {})
  }, [])

  const setLayoutAndPanels = (id: LayoutId): void => {
    setLayout(id)
    const n = layoutDef(id).count
    setPanels((prev) =>
      Array.from({ length: n }, (_, i) => prev[i] ?? { agentId: defaultAgent, clone: false })
    )
    setActivePresetId(null)
  }

  const applyPreset = (id: string): void => {
    const p = presets.find((x) => x.id === id)
    if (!p) return
    setLayout(p.layout)
    setPanels(p.panels.map((x) => ({ ...x })))
    setActivePresetId(id)
  }

  const pick = async (): Promise<void> => {
    const f = await window.api.dialog.pickFolder()
    if (f) {
      setFolder(f)
      if (!name) setName(f.split('/').pop() ?? 'workspace')
    }
  }

  const setPanel = (i: number, patch: Partial<PanelCfg>): void => {
    setPanels((p) => p.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
    setActivePresetId(null)
  }

  const saveCurrentAsPreset = (): void => {
    if (!presetName.trim()) {
      pushToast('warn', 'Введи имя пресета')
      return
    }
    savePreset(presetName.trim(), layout, panels)
    setPresetName('')
    setShowPresetSave(false)
    pushToast('info', 'Пресет сохранён')
  }

  const create = async (): Promise<void> => {
    // Папка необязательна: без неё агент стартует в домашней папке,
    // а папку проекта можно выбрать позже прямо в воркспейсе.
    setBusy(true)
    // Клон с GitHub (если указан репозиторий): клонируем в выбранную папку-родитель,
    // и папкой воркспейса становится склонированная директория.
    let wsFolder = folder
    if (cloneRepo.trim()) {
      try {
        wsFolder = await window.api.github.clone(cloneRepo.trim(), folder)
      } catch (e) {
        pushToast('error', `Клон не удался: ${e}`)
        setBusy(false)
        return
      }
    }
    let groupId: string | undefined
    const gn = groupName.trim()
    if (gn) {
      groupId = groups.find((g) => g.name.toLowerCase() === gn.toLowerCase())?.id ?? addGroup(gn).id
    }
    const ws = addWorkspace({
      name: name.trim() || (wsFolder ? wsFolder.split('/').pop() : '') || 'Без папки',
      folder: wsFolder,
      groupId,
      layout
    })
    for (const p of panels) {
      // cwd: пустую папку шлём как undefined → ядро возьмёт домашнюю папку
      await createSession({
        workspaceId: ws.id,
        agentId: p.agentId,
        cwd: wsFolder || undefined,
        clone: p.clone,
        shell: p.shell || undefined,
        extraArgs: p.extraArgs?.trim() || undefined
      })
    }
    setBusy(false)
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>Новый воркспейс</h3>

        {presets.length > 0 && (
          <>
            <label className="nw-section first">Пресеты</label>
            <div className="nw-presets">
              {presets.map((p) => (
                <span key={p.id} className={`preset-chip ${activePresetId === p.id ? 'sel' : ''}`}>
                  <button className="preset-apply" onClick={() => applyPreset(p.id)}>
                    {p.name}
                    <em>
                      {layoutDef(p.layout).label} · {p.panels.length} аг.
                    </em>
                  </button>
                  <button
                    className="preset-del"
                    title="Удалить пресет"
                    onClick={() => deletePreset(p.id)}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          </>
        )}

        <div className="nw-grid">
          <div className="nw-field">
            <label>Название</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="nw-field">
            <label>Группа</label>
            <input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              list="groups-list"
            />
            <datalist id="groups-list">
              {groups.map((g) => (
                <option key={g.id} value={g.name} />
              ))}
            </datalist>
          </div>
        </div>

        <div className="nw-field">
          <label>{cloneRepo.trim() ? 'Куда клонировать (родительская папка)' : 'Папка проекта'}</label>
          <div className="af-folder">
            <input value={folder} onChange={(e) => setFolder(e.target.value)} />
            <button onClick={pick}>Выбрать…</button>
          </div>
        </div>

        <div className="nw-field">
          <label>Клонировать с GitHub (необязательно)</label>
          <input
            list="gh-repos-list"
            value={cloneRepo}
            onChange={(e) => setCloneRepo(e.target.value)}
            placeholder="owner/repo или URL — клонируется в папку выше"
          />
          <datalist id="gh-repos-list">
            {ghRepos.map((r) => (
              <option key={r.nameWithOwner} value={r.nameWithOwner} />
            ))}
          </datalist>
        </div>

        <label className="nw-section">Раскладка панелей</label>
        <div className="nw-layouts">
          {LAYOUTS.map((l) => (
            <LayoutThumb key={l.id} id={l.id} selected={layout === l.id} onClick={() => setLayoutAndPanels(l.id)} />
          ))}
        </div>

        <div className="nw-section-row">
          <label className="nw-section">Что открыть в каждом окне</label>
          <button className="link-btn" onClick={() => setShowCliForm((v) => !v)}>
            ＋ свой CLI
          </button>
        </div>
        {showCliForm && <CustomCliForm onDone={() => setShowCliForm(false)} />}

        <div className="nw-panels">
          {panels.map((p, i) => (
            <div key={i} className="nw-panel">
              <span className="nw-panel-n">#{i + 1}</span>
              <select value={p.agentId} onChange={(e) => setPanel(i, { agentId: e.target.value })}>
                {pickable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.custom ? ' (свой)' : ''}
                  </option>
                ))}
              </select>
              <label className="nw-clone" title="Отдельная копия кода для этого агента (git worktree) — работает в своей ветке, потом сольёшь в основную">
                <input
                  type="checkbox"
                  checked={p.clone}
                  onChange={(e) => setPanel(i, { clone: e.target.checked })}
                />
                своя ветка
              </label>
              <select
                className="nw-shell"
                value={p.shell ?? ''}
                title="Оболочка запуска"
                onChange={(e) => setPanel(i, { shell: e.target.value })}
              >
                <option value="">оболочка</option>
                <option value="/bin/zsh">zsh</option>
                <option value="/bin/bash">bash</option>
                <option value="/bin/sh">sh</option>
              </select>
              <input
                className="nw-flags"
                value={p.extraArgs ?? ''}
                title="Доп. флаги агента"
                placeholder="флаги"
                onChange={(e) => setPanel(i, { extraArgs: e.target.value })}
              />
            </div>
          ))}
        </div>

        <div className="af-actions space">
          {showPresetSave ? (
            <div className="preset-save">
              <input
                autoFocus
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveCurrentAsPreset()}
              />
              <button className="btn-ghost sm" onClick={() => setShowPresetSave(false)}>
                ✕
              </button>
              <button className="btn-primary sm" onClick={saveCurrentAsPreset}>
                Сохранить
              </button>
            </div>
          ) : (
            <button className="link-btn" onClick={() => setShowPresetSave(true)}>
              ☆ Сохранить как пресет
            </button>
          )}
          <div className="af-actions-right">
            <button className="btn-ghost" onClick={onClose} disabled={busy}>
              Отмена
            </button>
            <button className="btn-primary" onClick={create} disabled={busy}>
              {busy ? 'Создаю…' : 'Создать воркспейс'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
