import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import type { ChangedFile, TestResult } from '../../../shared/types'
import './Review.css'

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

// RFC 0017 §3: фильтры «Ревью» (Issue Navigator). Тоггл по статусу юнита и по типу проблемы.
// Включённый статус = «показывать юниты с этим статусом» (все включены = ничего не прячем).
// Тоггл проблемы (конфликт / упавшие тесты) — режим «показать только такие»: если включён
// хоть один проблемный тоггл, юнит показывается лишь когда подходит под включённые проблемы.
type StatusKey = 'working' | 'awaiting' | 'error' | 'ready' | 'idle'
type IssueKey = 'conflict' | 'failed'

const STATUS_KEYS: StatusKey[] = ['working', 'awaiting', 'error', 'ready', 'idle']
const STATUS_LABEL: Record<StatusKey, string> = {
  working: 'работают',
  awaiting: 'ждут',
  error: 'ошибки',
  ready: 'готовы',
  idle: 'простой'
}

interface ReviewFilters {
  status: Record<StatusKey, boolean>
  issues: Record<IssueKey, boolean>
}

const FILTERS_KEY = 'deck.review.filters'

const defaultFilters = (): ReviewFilters => ({
  status: { working: true, awaiting: true, error: true, ready: true, idle: true },
  issues: { conflict: false, failed: false }
})

// Аккуратно поднимаем сохранённые фильтры из localStorage, добивая дефолтами недостающие ключи
// (чтобы при расширении набора статусов старое сохранение не ломалось).
const loadFilters = (): ReviewFilters => {
  const base = defaultFilters()
  try {
    const raw = localStorage.getItem(FILTERS_KEY)
    if (!raw) return base
    const saved = JSON.parse(raw) as Partial<ReviewFilters>
    return {
      status: { ...base.status, ...(saved.status ?? {}) },
      issues: { ...base.issues, ...(saved.issues ?? {}) }
    }
  } catch {
    return base
  }
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
  // id сессий юнита — статус считаем отдельным лёгким наложением (см. statusBySession),
  // чтобы смена статуса НЕ перестраивала структурный список юнитов.
  sessionIds: string[]
}

// Подпись файла для пометок «просмотрено/новое» (модульная, чтобы делить между Review и UnitCard).
const fileSig = (f: ChangedFile): string => `${f.status}:${f.path}`

// Один общий пустой набор путей: юниты без конфликтов получают ОДНУ и ту же ссылку →
// React.memo на UnitCard не считает проп conflictPaths изменившимся между тиками статуса.
const EMPTY_PATHS: Set<string> = new Set()
// Аналогично — общий пустой массив файлов (changes[folder] отсутствует), чтобы проп files был
// ссылочно-стабильным и React.memo не перерисовывал карточку из-за нового []-литерала.
const EMPTY_FILES: ChangedFile[] = []

// Карточка одного юнита (рабочего дерева): шапка + строки файлов + тесты.
// Вынесена в React.memo, чтобы тик статуса ОДНОЙ сессии (смена statusBySession) перерисовывал
// только бейдж статуса своего юнита, а не списки файлов всех юнитов. Получает в пропсах только то,
// что реально рисует: ссылочно-стабильные status/files/conflictPaths/seen/testResult/openOutput +
// стабильные колбэки (useCallback в родителе) — иначе React.memo не пропустит перерисовку.
type UnitCardProps = {
  unit: Unit
  status: StatusKey
  files: ChangedFile[]
  conflictPaths: Set<string> // относительные пути файлов ЭТОГО юнита, что в конфликте
  seen: Set<string> | undefined // снимок «просмотрено» для этой папки
  testResult: TestResult | undefined
  openOutput: boolean // открыт ли вывод тестов именно этого юнита
  onOpenFile: (u: Unit, f: ChangedFile) => void
  onRunTests: (folder: string) => void
  onMarkReviewed: (folder: string, files: ChangedFile[]) => void
  onToggleOutput: (folder: string) => void
}

const UnitCard = memo(function UnitCard({
  unit: u,
  status,
  files,
  conflictPaths,
  seen,
  testResult: tr,
  openOutput,
  onOpenFile,
  onRunTests,
  onMarkReviewed,
  onToggleOutput
}: UnitCardProps): JSX.Element {
  const newCount = files.filter((f) => !(seen?.has(fileSig(f)))).length
  return (
    <div className={`rv-unit status-${status}`}>
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
          onClick={() => onRunTests(u.folder)}
          disabled={tr?.running}
        >
          {tr?.running ? '⏳ тесты…' : '▶ тесты'}
        </button>
        {files.length > 0 && (
          <button
            className="rv-act"
            title="Отметить просмотренным (сбросить «новое»)"
            onClick={() => onMarkReviewed(u.folder, files)}
          >
            ✓ просмотрено
          </button>
        )}
      </div>

      {tr && !tr.running && (
        <div className={`rv-test ${tr.ok ? 'ok' : 'fail'}`}>
          <span className="rv-test-line" onClick={() => onToggleOutput(u.folder)}>
            {tr.error
              ? `⚠ ${tr.error}`
              : tr.ok
                ? `✅ тесты прошли (${tr.command})`
                : `❌ тесты упали — код ${tr.code ?? '?'} (${tr.command})`}
            {tr.output && (
              <span className="rv-test-toggle">{openOutput ? ' ▾ скрыть' : ' ▸ вывод'}</span>
            )}
          </span>
          {openOutput && tr.output && <pre className="rv-test-out">{tr.output}</pre>}
        </div>
      )}

      {files.length === 0 && <div className="rv-empty">без изменений</div>}
      {files.map((f) => {
        const conflict = conflictPaths.has(f.path)
        const isNew = !!seen && !seen.has(fileSig(f))
        return (
          <button
            key={f.path}
            className="rv-file"
            onClick={() => onOpenFile(u, f)}
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
})

export default function Review(): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const workspaces = useStore((s) => s.workspaces)
  // Структурная подпись юнитов: строка из ТОЛЬКО структурных полей (id/папки/ветки/имена).
  // Меняется при добавлении/удалении/переименовании сессий, смене папок/веток или
  // переименовании воркспейса — НЕ при смене статуса. По ней мемоизируем список юнитов,
  // чтобы частая смена статуса не перестраивала всю структуру (и не дёргала git-поллинг).
  const structSig = useStore((s) =>
    s.sessions
      .map((x) => `${x.id}|${x.workspaceId}|${x.cloneOf ?? ''}|${x.cwd}|${x.branch ?? ''}|${x.title}`)
      .join(';') +
    '##' +
    s.workspaces.map((w) => `${w.id}|${w.name}|${w.folder}`).join(';')
  )
  // Лёгкое наложение статусов: id сессии → статус. Перестраивается при смене статуса
  // (и только тогда), но это дешёвая Map — структурный список юнитов не трогается.
  const statusBySession = useStore(
    useShallow((s) => {
      const m: Record<string, string> = {}
      s.sessions.forEach((x) => {
        m[x.id] = x.status
      })
      return m
    })
  )
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
  // RFC 0017 §3: состояние фильтров (lazy-init из localStorage, как reviewed[]).
  const [filters, setFilters] = useState<ReviewFilters>(loadFilters)
  // Сохраняем фильтры при каждом изменении (зеркало паттерна reviewed[] → localStorage).
  useEffect(() => {
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(filters))
    } catch {
      /* ignore */
    }
  }, [filters])
  const toggleStatus = (k: StatusKey): void =>
    setFilters((p) => ({ ...p, status: { ...p.status, [k]: !p.status[k] } }))
  const toggleIssue = (k: IssueKey): void =>
    setFilters((p) => ({ ...p, issues: { ...p.issues, [k]: !p.issues[k] } }))
  const resetFilters = (): void => setFilters(defaultFilters())

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
  // Стабильные колбэки (useCallback) — иначе React.memo на UnitCard не пропустит перерисовку.
  const markReviewed = useCallback((folder: string, files: ChangedFile[]): void => {
    const sig = files.map(fileSig)
    localStorage.setItem(reviewKey(folder), JSON.stringify(sig))
    setReviewed((p) => ({ ...p, [folder]: new Set(sig) }))
  }, [])

  // Структурный список юнитов. Зависит ТОЛЬКО от structSig (структурные поля) — смена
  // статуса не перестраивает его (статус накладываем отдельно через statusBySession).
  // sessions/workspaces читаем для построения, но ключ мемо — structSig (поэтому eslint-disable).
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
          sessionIds: base.map((s) => s.id)
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
          sessionIds: [s.id]
        })
      })
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structSig])

  // изменения по уникальным папкам юнитов (poll + на входе)
  const unitKey = units.map((u) => u.key + u.folder).join(',')
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setInterval> | null = null
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
    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    const start = (): void => {
      if (timer === null) timer = setInterval(load, 6000)
    }
    // Пауза поллинга когда окно скрыто (фон/свёрнуто): не дёргаем git status вхолостую.
    // При возвращении — сразу подтягиваем свежее и снова запускаем интервал.
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        stop()
      } else {
        load()
        start()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    // первичная загрузка + старт интервала только если окно видно
    if (document.visibilityState === 'visible') {
      load()
      start()
    }
    return () => {
      alive = false
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitKey])

  // конфликт: ключ (база + относительный путь) правят ≥2 живых дерева.
  // Считаем по СОБСТВЕННОМУ пер-юнитному опросу Ревью (changes[u.folder] — git status каждого
  // дерева-юнита), а НЕ по общему store-селектору: store.changedFiles держит лишь ОДНО дерево
  // на воркспейс → переход на него ронял детект «две сессии — один файл» (регресс RFC 0014).
  // Ключ тот же: u.base + '::' + f.path.
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

  const open = useCallback(
    (u: Unit, f: ChangedFile): void => {
      setActiveWorkspace(u.wsId)
      setFocused(u.focusSessionId)
      setTab('workspace')
      selectFile({
        path: u.folder.replace(/\/$/, '') + '/' + f.path,
        name: f.path.split('/').pop() ?? f.path,
        diff: true
      })
    },
    [setActiveWorkspace, setFocused, setTab, selectFile]
  )

  // Стабильный колбэк прогона тестов (store-экшен runTests — стабильная ссылка zustand).
  const onRunTests = useCallback((folder: string): void => runTests(folder), [runTests])

  // Стабильный тоггл вывода тестов конкретного юнита (по папке).
  const onToggleOutput = useCallback(
    (folder: string): void => setOpenOutput((cur) => (cur === folder ? null : folder)),
    []
  )

  const totalChanges = units.reduce((n, u) => n + (changes[u.folder]?.length ?? 0), 0)

  // Статус каждого юнита (по ключу) = приоритет по статусам его сессий. Пересчёт на тик статуса,
  // но значения — строки-примитивы: у незатронутых юнитов та же строка → их UnitCard не перерисуется.
  const statusByUnit = useMemo<Record<string, StatusKey>>(() => {
    const m: Record<string, StatusKey> = {}
    units.forEach((u) => {
      const st = u.sessionIds.map((id) => statusBySession[id])
      m[u.key] = st.includes('working')
        ? 'working'
        : st.includes('awaiting')
          ? 'awaiting'
          : st.includes('error')
            ? 'error'
            : st.includes('ready')
              ? 'ready'
              : 'idle'
    })
    return m
  }, [units, statusBySession])

  // Конфликтные пути по юниту: Set относительных путей файлов юнита, что в conflictKeys.
  // Мемо на [units, conflictKeys] (conflictKeys зависит от changes) → НЕ пересчитывается на тик
  // статуса → ссылки Set'ов стабильны → UnitCard.conflictPaths не считается изменившимся.
  // Юниты без конфликта получают общий EMPTY_PATHS (одна ссылка).
  const conflictPathsByUnit = useMemo<Map<string, Set<string>>>(() => {
    const m = new Map<string, Set<string>>()
    units.forEach((u) => {
      const set = new Set<string>()
      ;(changes[u.folder] ?? []).forEach((f) => {
        if (conflictKeys.has(u.base + '::' + f.path)) set.add(f.path)
      })
      m.set(u.key, set.size > 0 ? set : EMPTY_PATHS)
    })
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units, conflictKeys])

  // Признаки проблем юнита (для фильтров по типу и бейджей серьёзности).
  const unitHasConflict = (u: Unit): boolean => (conflictPathsByUnit.get(u.key)?.size ?? 0) > 0
  // упавшие тесты: есть результат теста, не в процессе, и он не «ок» (упал или ошибка запуска).
  const unitTestsFailed = (u: Unit): boolean => {
    const tr = testResults[u.folder]
    return !!tr && !tr.running && (tr.ok === false || !!tr.error)
  }

  // Счётчики для бейджей фильтров (по всем юнитам, до применения самих фильтров).
  const statusCounts = useMemo<Record<StatusKey, number>>(() => {
    const c: Record<StatusKey, number> = { working: 0, awaiting: 0, error: 0, ready: 0, idle: 0 }
    units.forEach((u) => {
      c[statusByUnit[u.key]] += 1
    })
    return c
  }, [units, statusByUnit])
  const conflictCount = useMemo(
    () => units.filter((u) => (conflictPathsByUnit.get(u.key)?.size ?? 0) > 0).length,
    [units, conflictPathsByUnit]
  )
  const failedCount = useMemo(
    () => units.filter(unitTestsFailed).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [units, testResults]
  )

  // Применение фильтров: пустые юниты (по hideEmpty) + статус-тоггл + тип-проблемы.
  // Если включён хоть один проблемный тоггл — режим «только такие проблемы» (OR между ними).
  const anyIssueFilter = filters.issues.conflict || filters.issues.failed
  const passesFilters = (u: Unit): boolean => {
    if (hideEmpty && (changes[u.folder]?.length ?? 0) === 0) return false
    if (!filters.status[statusByUnit[u.key]]) return false
    if (anyIssueFilter) {
      const ok =
        (filters.issues.conflict && unitHasConflict(u)) ||
        (filters.issues.failed && unitTestsFailed(u))
      if (!ok) return false
    }
    return true
  }
  // Видимые юниты, сгруппированные по воркспейсам. Мемо на реальных входах фильтрации
  // (units/changes/statusByUnit/conflict/tests/filters/hideEmpty/workspaces).
  const byWs = useMemo(
    () =>
      workspaces
        .map((ws) => ({ ws, list: units.filter((u) => u.wsId === ws.id && passesFilters(u)) }))
        .filter((g) => g.list.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaces, units, changes, statusByUnit, conflictPathsByUnit, testResults, filters, hideEmpty]
  )
  // Сколько юнитов прячут ИМЕННО фильтры статуса/проблемы (без учёта hideEmpty — у него своя кнопка).
  const allStatusOn = STATUS_KEYS.every((k) => filters.status[k])
  const filtersActive = !allStatusOn || anyIssueFilter
  const hiddenByFilters = useMemo(() => {
    if (!filtersActive) return 0
    const pool = hideEmpty ? units.filter((u) => (changes[u.folder]?.length ?? 0) > 0) : units
    return pool.filter((u) => !passesFilters(u)).length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersActive, hideEmpty, units, changes, statusByUnit, conflictPathsByUnit, testResults, filters])

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

      {/* RFC 0017 §3: панель фильтров (Issue Navigator). Статусы + типы проблем + бейджи счётчиков. */}
      <div className="rv-filters">
        <span className="rv-filters-label">Статус:</span>
        {STATUS_KEYS.map((k) => (
          <button
            key={k}
            className={`rv-fbtn ${filters.status[k] ? 'on' : 'off'}`}
            onClick={() => toggleStatus(k)}
            title={`показывать юниты со статусом «${STATUS_LABEL[k]}»`}
          >
            <span className={`rv-fdot ${k}`} />
            {STATUS_LABEL[k]}
            <span className="rv-fbadge">{statusCounts[k]}</span>
          </button>
        ))}

        <span className="rv-filters-sep" />
        <span className="rv-filters-label">Проблемы:</span>
        <button
          className={`rv-fbtn ${filters.issues.conflict ? 'on' : 'off'}`}
          onClick={() => toggleIssue('conflict')}
          title="показать только юниты, где есть конфликт (файл правят ≥2 дерева)"
        >
          ⚠ конфликт
          <span className="rv-fbadge warn">{conflictCount}</span>
        </button>
        <button
          className={`rv-fbtn ${filters.issues.failed ? 'on' : 'off'}`}
          onClick={() => toggleIssue('failed')}
          title="показать только юниты с упавшими тестами"
        >
          ❌ упавшие тесты
          <span className="rv-fbadge bad">{failedCount}</span>
        </button>

        {filtersActive && (
          <button
            className="rv-filters-reset"
            onClick={resetFilters}
            title="сбросить фильтры (показать все)"
          >
            сброс{hiddenByFilters > 0 ? ` · скрыто ${hiddenByFilters}` : ''}
          </button>
        )}
      </div>

      {byWs.length === 0 &&
        (filtersActive && units.length > 0 ? (
          <div className="ov-empty">Под фильтры ничего не подходит — сбросьте фильтры выше.</div>
        ) : (
          <div className="ov-empty">Изменений нет — агенты ничего не наработали (или всё уже слито).</div>
        ))}

      {byWs.map(({ ws, list }) => (
        <div key={ws.id} className="ov-group">
          <div className="ov-group-head">
            <span className="ov-group-name">{ws.name}</span>
          </div>
          {list.map((u) => (
            <UnitCard
              key={u.key}
              unit={u}
              status={statusByUnit[u.key]}
              files={changes[u.folder] ?? EMPTY_FILES}
              conflictPaths={conflictPathsByUnit.get(u.key) ?? EMPTY_PATHS}
              seen={reviewed[u.folder]}
              testResult={testResults[u.folder]}
              openOutput={openOutput === u.folder}
              onOpenFile={open}
              onRunTests={onRunTests}
              onMarkReviewed={markReviewed}
              onToggleOutput={onToggleOutput}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
