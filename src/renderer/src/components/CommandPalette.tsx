import { useEffect, useMemo, useRef, useState } from 'react'
import './CommandPalette.css'
import { useStore } from '../store'
import type { SessionStatus } from '../../../shared/types'

// RFC 0017 X1: командная палитра (Cmd+K / Ctrl+K) — быстрый прыжок к
// сессии / воркспейсу / файлу или встроенному действию через нечёткий поиск.
// Открытие/закрытие держит store.commandPaletteOpen (хоткей в App.tsx).

// Тип строки в выдаче. group — секция-заголовок, run — что сделать по выбору.
type ItemKind = 'session' | 'workspace' | 'file' | 'action'
interface PaletteItem {
  id: string
  kind: ItemKind
  group: string // подпись секции (по типу)
  title: string // главная строка (что юзер видит)
  sub?: string // вторичная строка (воркспейс/путь)
  status?: SessionStatus // только для сессий — цвет точки
  // нечёткое сопоставление идёт по этой строке (в нижнем регистре)
  haystack: string
  run: () => void
}

// Нечёткий поиск: все символы запроса встречаются по порядку (подпоследовательность).
// Возвращает «оценку» (меньше = лучше): подряд-совпадения и старт ближе к началу — выше.
// null = не подходит. Пустой запрос подходит всему (оценка 0).
function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0
  let qi = 0
  let score = 0
  let prevIdx = -1
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) {
      // штраф за разрыв между совпавшими символами + за дальний старт
      if (prevIdx >= 0) score += ti - prevIdx - 1
      else score += ti
      prevIdx = ti
      qi++
    }
  }
  return qi === query.length ? score : null
}

// Простое имя файла из абсолютного пути.
function baseName(p: string): string {
  return p.split('/').pop() ?? p
}

export default function CommandPalette({ onNew }: { onNew: () => void }): JSX.Element {
  const setOpen = useStore((s) => s.setCommandPaletteOpen)
  const sessions = useStore((s) => s.sessions)
  const workspaces = useStore((s) => s.workspaces)
  const agents = useStore((s) => s.agents)
  const customAgents = useStore((s) => s.customAgents)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace)
  const setFocused = useStore((s) => s.setFocused)
  const setTab = useStore((s) => s.setTab)
  const selectFile = useStore((s) => s.selectFile)

  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  // файлы активного воркспейса (один уровень) — подгружаем, когда палитра открыта
  const [files, setFiles] = useState<{ path: string; name: string }[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const close = (): void => setOpen(false)

  // имя агента (встроенный + свой CLI) — для подписи сессии
  const agentName = useMemo(() => {
    const m = new Map<string, string>()
    agents.forEach((a) => m.set(a.id, a.name))
    customAgents.forEach((c) => m.set(c.id, c.name))
    return m
  }, [agents, customAgents])

  // фокус в поле ввода при открытии
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // подгрузка файлов активного воркспейса (верхний уровень папки) — для поиска по файлам.
  // Без ядра/Tauri readDir отклонится → список просто пустой (палитра работает дальше).
  useEffect(() => {
    const ws = workspaces.find((w) => w.id === activeWorkspaceId)
    if (!ws?.folder) {
      setFiles([])
      return
    }
    let cancelled = false
    window.api.fs
      .readDir(ws.folder)
      .then((entries) => {
        if (cancelled) return
        // только файлы (папки в палитре не открываем — это прыжок к содержимому)
        setFiles(entries.filter((e) => !e.isDir).map((e) => ({ path: e.path, name: e.name })))
      })
      .catch(() => {
        if (!cancelled) setFiles([])
      })
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId, workspaces])

  // полный список кандидатов (до фильтра). Группы идут в фиксированном порядке.
  const allItems = useMemo<PaletteItem[]>(() => {
    const wsName = (id: string): string => workspaces.find((w) => w.id === id)?.name ?? '—'
    const items: PaletteItem[] = []

    // действия
    const actions: Array<{ title: string; run: () => void }> = [
      { title: 'Новый воркспейс', run: () => { close(); onNew() } },
      { title: 'Открыть Задачи', run: () => { close(); setTab('backlog') } },
      { title: 'Открыть Ревью', run: () => { close(); setTab('review') } },
      { title: 'Настройки', run: () => { close(); setTab('settings') } }
    ]
    actions.forEach((a, i) =>
      items.push({
        id: `action:${i}`,
        kind: 'action',
        group: 'Действия',
        title: a.title,
        haystack: a.title.toLowerCase(),
        run: a.run
      })
    )

    // сессии (по заголовку + имени воркспейса)
    sessions.forEach((s) => {
      const wn = wsName(s.workspaceId)
      const aName = agentName.get(s.agentId) ?? s.agentId
      const title = s.title || aName
      items.push({
        id: `session:${s.id}`,
        kind: 'session',
        group: 'Сессии',
        title,
        sub: wn,
        status: s.status,
        haystack: `${title} ${wn} ${aName}`.toLowerCase(),
        run: () => {
          close()
          setActiveWorkspace(s.workspaceId)
          setFocused(s.id)
          setTab('workspace')
        }
      })
    })

    // воркспейсы (по имени)
    workspaces.forEach((w) => {
      items.push({
        id: `workspace:${w.id}`,
        kind: 'workspace',
        group: 'Воркспейсы',
        title: w.name,
        sub: w.folder || undefined,
        haystack: `${w.name} ${w.folder}`.toLowerCase(),
        run: () => {
          close()
          setActiveWorkspace(w.id)
          setTab('workspace')
        }
      })
    })

    // файлы активного воркспейса (верхний уровень)
    files.forEach((f) => {
      items.push({
        id: `file:${f.path}`,
        kind: 'file',
        group: 'Файлы',
        title: f.name,
        sub: f.path,
        haystack: `${f.name} ${f.path}`.toLowerCase(),
        run: () => {
          close()
          selectFile({ path: f.path, name: f.name })
        }
      })
    })

    return items
    // close/setters стабильны (zustand); onNew от App стабилен через useState-сеттер.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, workspaces, files, agentName])

  // фильтр + сортировка по «оценке» нечёткого совпадения; сохраняем порядок групп.
  const GROUP_ORDER = ['Сессии', 'Воркспейсы', 'Файлы', 'Действия']
  const filtered = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase()
    const scored: Array<{ item: PaletteItem; score: number; gi: number }> = []
    for (const item of allItems) {
      const score = fuzzyScore(q, item.haystack)
      if (score === null) continue
      scored.push({ item, score, gi: GROUP_ORDER.indexOf(item.group) })
    }
    // сначала по группе (стабильный порядок секций), внутри — по оценке (лучшее выше)
    scored.sort((a, b) => (a.gi !== b.gi ? a.gi - b.gi : a.score - b.score))
    return scored.map((x) => x.item)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allItems, query])

  // сбрасываем подсветку на первый элемент при смене запроса/набора
  useEffect(() => {
    setActive(0)
  }, [query, filtered.length])

  // прокрутка к активной строке (чтобы она не уезжала за пределы видимой части)
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('.cp-row.active')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // навигация с клавиатуры внутри палитры. preventDefault на стрелках/Enter/Esc,
  // чтобы фокус не убегал и страница не скроллилась под палитрой.
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (filtered.length ? (i + 1) % filtered.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      filtered[active]?.run()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  // группируем отфильтрованное по секциям для рендера заголовков. Индекс в плоском
  // списке нужен для подсветки активной строки (active = индекс в filtered).
  let flatIdx = -1
  const rendered: JSX.Element[] = []
  let lastGroup = ''
  filtered.forEach((item) => {
    flatIdx++
    const idx = flatIdx
    if (item.group !== lastGroup) {
      lastGroup = item.group
      rendered.push(
        <div key={`g:${item.group}`} className="cp-group-label">
          {item.group}
        </div>
      )
    }
    rendered.push(
      <div
        key={item.id}
        className={`cp-row ${idx === active ? 'active' : ''}`}
        onMouseEnter={() => setActive(idx)}
        onClick={() => item.run()}
      >
        <span className="cp-ico">
          {item.kind === 'session' ? (
            <span className={`cp-dot ${item.status ?? 'idle'}`} />
          ) : item.kind === 'workspace' ? (
            '▦'
          ) : item.kind === 'file' ? (
            '📄'
          ) : (
            '⌘'
          )}
        </span>
        <span className="cp-main">
          <span className="cp-title">{item.title}</span>
          {item.sub && <span className="cp-sub">{item.sub}</span>}
        </span>
        {item.kind !== 'action' && (
          <span className="cp-kind">
            {item.kind === 'session'
              ? 'сессия'
              : item.kind === 'workspace'
                ? 'воркспейс'
                : 'файл'}
          </span>
        )}
      </div>
    )
  })

  return (
    <div className="cp-backdrop" onClick={close}>
      <div className="cp-panel" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <input
          ref={inputRef}
          className="cp-input"
          placeholder="Прыжок к сессии, воркспейсу, файлу или действию…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="cp-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="cp-empty">Ничего не найдено</div>
          ) : (
            rendered
          )}
        </div>
      </div>
    </div>
  )
}
