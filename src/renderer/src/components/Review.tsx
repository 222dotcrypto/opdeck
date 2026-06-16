import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import type { ChangedFile } from '../../../shared/types'

// RFC 0014 (Этап 3): очередь ревью. Лента изменённых файлов по ВСЕМ сессиям (рабочим деревьям),
// дифф в один клик, предупреждение «две сессии правят один файл». Diff/статусы — через готовый
// gitops::status/diff_file (RFC 0011) по папке каждого юнита.

const STATUS_GLYPH: Record<string, string> = {
  modified: 'м',
  added: '+',
  deleted: '−',
  renamed: '→',
  untracked: '?'
}

// Юнит ревью = отдельное рабочее дерево: своя ветка (клон-сессия) ИЛИ основная папка воркспейса.
type Unit = {
  key: string
  folder: string // папка для git_status + diff (== diffSourceFolder для фокус-сессии)
  base: string // база ключа конфликта: cloneOf (для клона) ИЛИ папка воркспейса
  wsId: string
  wsName: string
  label: string
  branch?: string
  focusSessionId: string
  statuses: string[]
}

export default function Review(): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const workspaces = useStore((s) => s.workspaces)
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace)
  const setFocused = useStore((s) => s.setFocused)
  const setTab = useStore((s) => s.setTab)
  const selectFile = useStore((s) => s.selectFile)
  const testResults = useStore((s) => s.testResults)
  const runTests = useStore((s) => s.runTests)
  const [changes, setChanges] = useState<Record<string, ChangedFile[]>>({})
  const [hideEmpty, setHideEmpty] = useState(true)
  // RFC 0014 Фаза 2: «просмотрено» — снимок набора файлов на момент последнего взгляда (localStorage).
  const [reviewed, setReviewed] = useState<Record<string, Set<string>>>({})
  const [openOutput, setOpenOutput] = useState<string | null>(null)

  const fileSig = (f: ChangedFile): string => `${f.status}:${f.path}`
  const reviewKey = (folder: string): string => 'deck.reviewed.' + folder
  useEffect(() => {
    // подгружаем сохранённые снимки «просмотрено» один раз
    const next: Record<string, Set<string>> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('deck.reviewed.')) {
        try {
          next[k.slice('deck.reviewed.'.length)] = new Set(JSON.parse(localStorage.getItem(k) || '[]'))
        } catch {
          /* ignore */
        }
      }
    }
    setReviewed(next)
  }, [])
  const markReviewed = (folder: string, files: ChangedFile[]): void => {
    const sig = files.map(fileSig)
    localStorage.setItem(reviewKey(folder), JSON.stringify(sig))
    setReviewed((p) => ({ ...p, [folder]: new Set(sig) }))
  }

  const units = useMemo<Unit[]>(() => {
    const out: Unit[] = []
    workspaces.forEach((ws) => {
      const wsSessions = sessions.filter((s) => s.workspaceId === ws.id)
      const isClone = (s: (typeof wsSessions)[number]): boolean => !!(s.cloneOf && s.cwd && s.cwd !== ws.folder)
      // основная папка воркспейса (не-клон сессии делят одно дерево)
      const base = wsSessions.filter((s) => !isClone(s))
      if (base.length > 0) {
        out.push({
          key: 'base:' + ws.id,
          folder: ws.folder,
          base: ws.folder,
          wsId: ws.id,
          wsName: ws.name,
          label: 'основная',
          focusSessionId: base[0].id,
          statuses: base.map((s) => s.status)
        })
      }
      // клон-сессии (свои ветки) — каждая отдельное дерево
      wsSessions.filter(isClone).forEach((s) => {
        out.push({
          key: 'clone:' + s.id,
          folder: s.cwd,
          base: s.cloneOf ?? s.cwd,
          wsId: ws.id,
          wsName: ws.name,
          label: s.branch ? (s.branch.split('/').pop() ?? s.branch) : s.title,
          branch: s.branch,
          focusSessionId: s.id,
          statuses: [s.status]
        })
      })
    })
    return out
  }, [sessions, workspaces])

  // изменения по уникальным папкам юнитов (poll + на входе)
  const unitKey = units.map((u) => u.key + u.folder).join(',')
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      const folders = Array.from(new Set(units.map((u) => u.folder).filter(Boolean)))
      const out: Record<string, ChangedFile[]> = {}
      await Promise.all(
        folders.map(async (f) => {
          try {
            out[f] = await window.api.git.status(f)
          } catch {
            out[f] = []
          }
        })
      )
      if (alive) setChanges(out)
    }
    load()
    const t = setInterval(load, 6000)
    return () => {
      alive = false
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitKey])

  // конфликт: ключ (база + относительный путь) встречается у ≥2 юнитов
  const conflictKeys = useMemo(() => {
    const count = new Map<string, number>()
    units.forEach((u) =>
      (changes[u.folder] ?? []).forEach((f) => {
        const k = u.base + '::' + f.path
        count.set(k, (count.get(k) ?? 0) + 1)
      })
    )
    const set = new Set<string>()
    count.forEach((n, k) => {
      if (n >= 2) set.add(k)
    })
    return set
  }, [units, changes])

  const open = (u: Unit, f: ChangedFile): void => {
    setActiveWorkspace(u.wsId)
    setFocused(u.focusSessionId)
    setTab('workspace')
    selectFile({
      path: u.folder.replace(/\/$/, '') + '/' + f.path,
      name: f.path.split('/').pop() ?? f.path,
      diff: true
    })
  }

  const shown = units.filter((u) => !hideEmpty || (changes[u.folder]?.length ?? 0) > 0)
  const totalChanges = units.reduce((n, u) => n + (changes[u.folder]?.length ?? 0), 0)
  const byWs = workspaces
    .map((ws) => ({ ws, list: shown.filter((u) => u.wsId === ws.id) }))
    .filter((g) => g.list.length > 0)

  const unitStatus = (u: Unit): string =>
    u.statuses.includes('working')
      ? 'working'
      : u.statuses.includes('awaiting')
        ? 'awaiting'
        : u.statuses.includes('error')
          ? 'error'
          : u.statuses.includes('ready')
            ? 'ready'
            : 'idle'

  return (
    <div className="review">
      <div className="ov-bar">
        <span className="ov-bar-title">Ревью изменений</span>
        <span className="ov-wt" title="всего изменённых файлов по всем сессиям">
          {totalChanges} правок
        </span>
        <button className="ws-tb-btn" onClick={() => setHideEmpty((v) => !v)}>
          {hideEmpty ? 'показать пустые' : 'скрыть пустые'}
        </button>
      </div>

      {byWs.length === 0 && (
        <div className="ov-empty">Изменений нет — агенты ничего не наработали (или всё уже слито).</div>
      )}

      {byWs.map(({ ws, list }) => (
        <div key={ws.id} className="ov-group">
          <div className="ov-group-head">
            <span className="ov-group-name">{ws.name}</span>
          </div>
          {list.map((u) => {
            const files = changes[u.folder] ?? []
            const seen = reviewed[u.folder]
            const newCount = files.filter((f) => !(seen?.has(fileSig(f)))).length
            const tr = testResults[u.folder]
            return (
              <div key={u.key} className={`rv-unit status-${unitStatus(u)}`}>
                <div className="rv-unit-head">
                  <span className={`rv-branch${u.branch ? '' : ' base'}`}>
                    {u.branch ? '⑂ ' : ''}
                    {u.label}
                  </span>
                  {newCount > 0 && seen && <span className="rv-new-badge">{newCount} новых</span>}
                  <span className="rv-count">{files.length}</span>
                  <button
                    className="rv-act"
                    title="Прогнать тесты проекта (npm/cargo/make)"
                    onClick={() => runTests(u.folder)}
                    disabled={tr?.running}
                  >
                    {tr?.running ? '⏳ тесты…' : '▶ тесты'}
                  </button>
                  {files.length > 0 && (
                    <button
                      className="rv-act"
                      title="Отметить просмотренным (сбросить «новое»)"
                      onClick={() => markReviewed(u.folder, files)}
                    >
                      ✓ просмотрено
                    </button>
                  )}
                </div>

                {tr && !tr.running && (
                  <div className={`rv-test ${tr.ok ? 'ok' : 'fail'}`}>
                    <span
                      className="rv-test-line"
                      onClick={() => setOpenOutput(openOutput === u.folder ? null : u.folder)}
                    >
                      {tr.error
                        ? `⚠ ${tr.error}`
                        : tr.ok
                          ? `✅ тесты прошли (${tr.command})`
                          : `❌ тесты упали — код ${tr.code ?? '?'} (${tr.command})`}
                      {tr.output && <span className="rv-test-toggle">{openOutput === u.folder ? ' ▾ скрыть' : ' ▸ вывод'}</span>}
                    </span>
                    {openOutput === u.folder && tr.output && <pre className="rv-test-out">{tr.output}</pre>}
                  </div>
                )}

                {files.length === 0 && <div className="rv-empty">без изменений</div>}
                {files.map((f) => {
                  const conflict = conflictKeys.has(u.base + '::' + f.path)
                  const isNew = !!seen && !seen.has(fileSig(f))
                  return (
                    <button
                      key={f.path}
                      className="rv-file"
                      onClick={() => open(u, f)}
                      title={conflict ? 'этот файл правит и другая сессия — риск конфликта' : 'открыть дифф'}
                    >
                      <span className={`rv-st rv-st-${f.status}`}>{STATUS_GLYPH[f.status] ?? '•'}</span>
                      <span className="rv-path">{f.path}</span>
                      {isNew && <span className="rv-new" title="новое с последнего просмотра">●</span>}
                      {conflict && <span className="rv-conflict">⚠</span>}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
