// RFC 0017 X4 — Инспектор сессии (вкладка правой панели «Инспектор»).
// По сфокусированной сессии показывает: агент, статус, ветку, папку, хвост вывода
// (~последние строки из store.sessionOutputTail, автопрокрутка вниз) и «кто ещё
// правит этот файл» (по выбранному файлу — другие сессии из editorsByKey конфликтов).
// Если сессия не выбрана — бледная подсказка. Вкладку «Файлы» НЕ трогает (она рядом).
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useStore, useSessionTail, useConflictInfo } from '../store'
import type { Session, SessionStatus } from '../../../shared/types'
import './SessionInspector.css'

// Человекочитаемая подпись статуса (как в остальном UI — по-русски).
const STATUS_LABEL: Record<SessionStatus, string> = {
  ready: 'готов',
  working: 'работает',
  awaiting: 'ждёт ответа',
  error: 'ошибка',
  idle: 'простаивает'
}

// Сократить домашний путь до «~» (как в тулбаре воркспейса).
function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~')
}

export default function SessionInspector(): JSX.Element {
  const focusedId = useStore((s) => s.focusedSessionId)
  // Узкая подписка: сама сессия (по фокусу). Меняется только она — перерисуемся.
  const session = useStore((s) => s.sessions.find((x) => x.id === focusedId)) as
    | Session
    | undefined
  // Имя агента: встроенный/свой CLI по id (как в applyDetectedCli). Подписываемся на
  // agents — список меняется редко (загрузка при init), лишних перерисовок не будет.
  const agents = useStore((s) => s.agents)
  const selectedFile = useStore((s) => s.selectedFile)
  const workspaces = useStore((s) => s.workspaces)

  // Хвост вывода именно этой сессии (узкая подписка из стора, ANSI вычищен).
  const tail = useSessionTail(session?.id)
  // Общий селектор конфликтов: «кто правит файл». Подписан на подпись, не на статус-тики.
  const { editorsByKey } = useConflictInfo()

  // ── «Кто ещё правит этот файл» ──────────────────────────────────────────────
  // Ключ конфликта = base + '::' + относительный путь файла (точь-в-точь как в Review
  // и в useConflictInfo). База для файла активного воркспейса = его папка; путь файла
  // в сторе абсолютный — снимаем (folder + '/') как делает FileTree. Если выбранный
  // файл вне папки воркспейса фокус-сессии — ключ не совпадёт, «других» не покажем.
  const others = useMemo<string[]>(() => {
    if (!session || !selectedFile) return []
    const ws = workspaces.find((w) => w.id === session.workspaceId)
    if (!ws || !ws.folder) return []
    const base = ws.folder.replace(/\/$/, '')
    // относительный путь: абсолютный минус (folder + '/'); если файл не из этой папки — пропускаем
    if (!selectedFile.path.startsWith(base + '/')) return []
    const relpath = selectedFile.path.slice(base.length + 1)
    const key = base + '::' + relpath
    const editors = editorsByKey.get(key) ?? []
    // «другие» = все правящие минус текущая сессия
    return editors.filter((id) => id !== session.id)
  }, [session, selectedFile, workspaces, editorsByKey])

  // Имена «других» сессий (заголовок или id) — для читаемого списка.
  const sessions = useStore((s) => s.sessions)
  const otherLabels = useMemo<string[]>(
    () =>
      others.map((id) => {
        const s = sessions.find((x) => x.id === id)
        return s?.title || id.slice(0, 8)
      }),
    [others, sessions]
  )

  // Автопрокрутка хвоста вниз при поступлении нового вывода.
  const tailRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = tailRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [tail])

  // Сброс прокрутки при смене сессии (новый хвост — показываем сверху-вниз заново).
  useEffect(() => {
    const el = tailRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session?.id])

  if (!session) {
    return (
      <div className="si-root">
        <div className="si-empty">
          Выбери окно агента слева —
          <br />
          здесь покажется его статус, ветка и вывод.
        </div>
      </div>
    )
  }

  const agentName = agents.find((a) => a.id === session.agentId)?.name ?? session.agentId
  const status = session.status
  const isClone = !!session.cloneOf
  // Имя ветки: своя ветка клона (branch), иначе намёк, что это основное дерево.
  const branchText = session.branch || (isClone ? '(своя ветка)' : null)

  // Имя выбранного файла для подзаголовка блока «кто ещё правит».
  const selFileName = selectedFile?.name

  return (
    <div className="si-root">
      <div className="si-head">
        <span className="si-agent" title={agentName}>
          {agentName}
        </span>
        {session.title && session.title !== agentName && (
          <span className="si-title" title={session.title}>
            {session.title}
          </span>
        )}
        <span className={`si-badge status-${status}`}>
          <span className="si-dot" />
          {STATUS_LABEL[status]}
        </span>
      </div>

      <div className="si-meta">
        <div className="si-row">
          <span className="si-key">Ветка</span>
          {branchText ? (
            <span className="si-val">
              {isClone && <span className="si-branch-mark">⑂ </span>}
              {branchText}
            </span>
          ) : (
            <span className="si-val muted">основное дерево</span>
          )}
        </div>
        <div className="si-row">
          <span className="si-key">Папка</span>
          <span className="si-val" title={session.cwd}>
            {session.cwd ? shortPath(session.cwd) : '—'}
          </span>
        </div>
      </div>

      {/* Кто ещё правит выбранный файл (если файл открыт). */}
      {selectedFile && (
        <div className="si-others">
          <div className="si-others-head">
            КТО ЕЩЁ ПРАВИТ{' '}
            {selFileName && <span className="si-others-file">«{selFileName}»</span>}
          </div>
          {otherLabels.length ? (
            <div className="si-others-list">
              {otherLabels.map((label, i) => (
                <div className="si-other" key={others[i]}>
                  <span className="si-dot" />
                  {label}
                </div>
              ))}
            </div>
          ) : (
            <div className="si-others-none">Только эта сессия.</div>
          )}
        </div>
      )}

      <div className="si-tail-head">ВЫВОД</div>
      <div className="si-tail" ref={tailRef}>
        {tail.length ? (
          tail.join('\n')
        ) : (
          <span className="si-tail-empty">Вывода пока нет.</span>
        )}
      </div>
    </div>
  )
}
