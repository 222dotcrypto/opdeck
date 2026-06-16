import { useEffect, useState } from 'react'
import { useStore } from '../store'
import CustomCliForm from './CustomCliForm'

interface GhStatus {
  installed: boolean
  authed: boolean
  user?: string
}
interface GhRepo {
  nameWithOwner: string
  description: string
  private: boolean
}

function GithubSection(): JSX.Element {
  const [status, setStatus] = useState<GhStatus | null>(null)
  const [repos, setRepos] = useState<GhRepo[] | null>(null)
  const [loading, setLoading] = useState(false)
  const pushToast = useStore((s) => s.pushToast)

  const refresh = (): void => {
    window.api.github
      .status()
      .then(setStatus)
      .catch(() => setStatus({ installed: false, authed: false }))
  }
  useEffect(refresh, [])

  const loadRepos = async (): Promise<void> => {
    setLoading(true)
    try {
      setRepos(await window.api.github.repos())
    } catch (e) {
      pushToast('error', `Не удалось получить репозитории: ${e}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-head">
        <h3>GitHub</h3>
        {status?.authed && <span className="settings-soon" style={{ borderColor: 'var(--ready)', color: 'var(--ready)' }}>подключён</span>}
      </div>
      <p className="settings-hint">
        Через установленный <code>gh</code> (GitHub CLI). Клонируй репозитории в воркспейсы прямо из
        мастера создания (вкладка «Воркспейс» → ＋ → «Клонировать с GitHub»).
      </p>

      {status === null && <div className="settings-empty">Проверяю gh…</div>}
      {status && !status.installed && (
        <div className="settings-empty">
          <code>gh</code> не установлен. Поставь: <code>brew install gh</code>, затем{' '}
          <code>gh auth login</code>.
        </div>
      )}
      {status && status.installed && !status.authed && (
        <div className="settings-empty">
          <code>gh</code> установлен, но не авторизован. Выполни в терминале{' '}
          <code>gh auth login</code> и нажми «Обновить».
        </div>
      )}
      {status?.authed && (
        <>
          <div className="settings-cli" style={{ marginBottom: 8 }}>
            <div className="settings-cli-main">
              <span className="settings-cli-name">Аккаунт: {status.user}</span>
              <span className="settings-cli-cmd">авторизован через gh</span>
            </div>
            <button className="ws-tb-btn" onClick={loadRepos} disabled={loading}>
              {loading ? 'Загрузка…' : repos ? 'Обновить список' : 'Показать репозитории'}
            </button>
          </div>
          {repos && (
            <div className="settings-cli-list">
              {repos.length === 0 && <div className="settings-empty">Репозиториев нет.</div>}
              {repos.map((r) => (
                <div key={r.nameWithOwner} className="settings-cli">
                  <div className="settings-cli-main">
                    <span className="settings-cli-name">
                      {r.nameWithOwner} {r.private && <span style={{ color: 'var(--text-3)' }}>· приватный</span>}
                    </span>
                    {r.description && <span className="settings-cli-cmd">{r.description}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div style={{ marginTop: 8 }}>
        <button className="link-btn" onClick={refresh}>↻ Обновить статус</button>
      </div>
    </section>
  )
}

// RFC 0015: «режим доверия» CLI для Deck-сессий — насколько свободно агент действует без
// подтверждений. Применяется нативным флагом запуска (Claude --permission-mode; Codex -a/-s).
function TrustSection(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const sel = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    opts: [string, string][]
  ): JSX.Element => (
    <label className="settings-sel">
      <span className="settings-sel-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {opts.map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
    </label>
  )
  return (
    <section className="settings-section">
      <div className="settings-head">
        <h3>Доверие агентам (для Deck-сессий)</h3>
      </div>
      <p className="settings-hint">
        Насколько свободно агент действует без подтверждений. Применяется к сессиям, запущенным из
        Deck (личные настройки CLI не трогаются). «По умолчанию» — поведение самого CLI.
      </p>
      {sel('Claude', settings.claudePermissionMode ?? '', (v) => updateSettings({ claudePermissionMode: v }), [
        ['', 'по умолчанию (спрашивает)'],
        ['acceptEdits', 'принимать правки сам'],
        ['bypassPermissions', 'разрешить всё'],
        ['plan', 'только чтение (режим плана)']
      ])}
      {sel('Codex · подтверждения', settings.codexApproval ?? '', (v) => updateSettings({ codexApproval: v }), [
        ['', 'по умолчанию'],
        ['untrusted', 'только доверенные команды'],
        ['on-request', 'по запросу модели'],
        ['never', 'не спрашивать']
      ])}
      {sel('Codex · песочница', settings.codexSandbox ?? '', (v) => updateSettings({ codexSandbox: v }), [
        ['', 'по умолчанию'],
        ['read-only', 'только чтение'],
        ['workspace-write', 'запись в рабочую папку'],
        ['danger-full-access', 'полный доступ']
      ])}
    </section>
  )
}

export default function Settings(): JSX.Element {
  const customAgents = useStore((s) => s.customAgents)
  const removeCustomAgent = useStore((s) => s.removeCustomAgent)
  const [adding, setAdding] = useState(false)

  return (
    <div className="settings">
      <h2 className="settings-title">Настройки</h2>

      <section className="settings-section">
        <div className="settings-head">
          <h3>Свои CLI</h3>
          <button className="ws-tb-btn" onClick={() => setAdding((v) => !v)}>
            ＋ Добавить CLI
          </button>
        </div>
        <p className="settings-hint">
          Свои команды-агенты (напр. <code>aider --model gpt-5</code>). Появляются во всех списках
          выбора при создании сессии.
        </p>
        {adding && <CustomCliForm onDone={() => setAdding(false)} />}
        <div className="settings-cli-list">
          {customAgents.length === 0 && <div className="settings-empty">Пока нет своих CLI.</div>}
          {customAgents.map((c) => (
            <div key={c.id} className="settings-cli">
              <div className="settings-cli-main">
                <span className="settings-cli-name">{c.name}</span>
                <span className="settings-cli-cmd">{c.command}</span>
              </div>
              <button
                className="settings-cli-del"
                title="Удалить"
                onClick={() => removeCustomAgent(c.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </section>

      <TrustSection />

      <GithubSection />
    </div>
  )
}
