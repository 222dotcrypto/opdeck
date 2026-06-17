import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import AddSessionForm from './AddSessionForm'
import EditableName from './EditableName'
import type { Session, SessionStatus, Workspace } from '../../../shared/types'

const STATUS_LABEL: Record<SessionStatus, string> = {
  ready: 'готов',
  working: 'работает',
  awaiting: 'ждёт ответа',
  error: 'ошибка',
  idle: 'простаивает'
}

// Цель переноса: id группы, либо 'ungrouped' (без группы), либо null (мимо).
// Зеркало механизма из Sidebar.
type DropTarget = string | 'ungrouped' | null

// байты → компактно (1.4 ГБ / 320 МБ)
function fmtBytes(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' ГБ'
  if (n >= 1e6) return Math.round(n / 1e6) + ' МБ'
  if (n >= 1e3) return Math.round(n / 1e3) + ' КБ'
  return n + ' Б'
}

export default function Overview({ onNew }: { onNew: (groupName?: string) => void }): JSX.Element {
  const groups = useStore((s) => s.groups)
  const workspaces = useStore((s) => s.workspaces)
  const sessions = useStore((s) => s.sessions)
  const agents = useStore((s) => s.agents)
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace)
  const setFocused = useStore((s) => s.setFocused)
  const worktreeStats = useStore((s) => s.worktreeStats)
  const refreshWorktreeStats = useStore((s) => s.refreshWorktreeStats)
  const killAllSessions = useStore((s) => s.killAllSessions)
  const removeWorktreeFor = useStore((s) => s.removeWorktreeFor)
  const moveWorkspaceToGroup = useStore((s) => s.moveWorkspaceToGroup)
  const [addingTo, setAddingTo] = useState<string | null>(null)
  const [confirmKill, setConfirmKill] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  // Перетаскивание воркспейса между группами (ручное, мышью) — как в Sidebar.
  const [draggingWsId, setDraggingWsId] = useState<string | undefined>()
  const [dragOverGroup, setDragOverGroup] = useState<DropTarget>(null)

  // RFC 0012: освежаем статистику веток при входе в Сводку и при изменении числа сессий
  const aliveCount = sessions.filter((s) => s.alive).length
  useEffect(() => {
    refreshWorktreeStats()
  }, [sessions.length, refreshWorktreeStats])

  // Карта «id сессии → сессия» строится ОДИН раз за рендер: renderColumn раньше
  // делал sessions.find() на каждый sessionId каждого воркспейса (O(сессии×колонки)).
  // Зависит только от sessions — смена статуса одной сессии пересоздаёт массив и
  // карту, что и нужно: карточка статуса должна обновиться.
  const sessionsById = useMemo(() => {
    const m = new Map<string, Session>()
    sessions.forEach((s) => m.set(s.id, s))
    return m
  }, [sessions])

  // Имена агентов — тоже карта вместо .find() на каждую карточку.
  const agentNameById = useMemo(() => {
    const m = new Map<string, string>()
    agents.forEach((a) => m.set(a.id, a.name))
    return m
  }, [agents])

  const agentName = (id: string): string => agentNameById.get(id) ?? id

  const openSession = (wsId: string, sid: string): void => {
    setActiveWorkspace(wsId)
    setFocused(sid)
    useStore.getState().setTab('workspace')
  }

  // Перетаскивание колонки-воркспейса в группу — точное зеркало Sidebar.startWsDrag.
  // Тащим только за шапку колонки (.ov-col-head), чтобы клики по карточкам,
  // переименование и кнопка «＋ сессия» продолжали работать как раньше.
  const startWsDrag = (e: React.MouseEvent, w: Workspace): void => {
    if (e.button !== 0) return
    // нажатие на интерактив в шапке (имя, кнопка «＋») — не перетаскивание
    if ((e.target as HTMLElement).closest('.ov-add, .ov-col-name, input, [contenteditable]')) return
    const sx = e.clientX
    const sy = e.clientY
    let dragging = false

    const groupAt = (x: number, y: number): DropTarget => {
      const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('[data-drop-group]')
      const g = el?.getAttribute('data-drop-group')
      return g === undefined || g === null ? null : (g as DropTarget)
    }

    const onMove = (ev: MouseEvent): void => {
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) {
        dragging = true
        setDraggingWsId(w.id)
        document.body.style.cursor = 'grabbing'
      }
      if (dragging) setDragOverGroup(groupAt(ev.clientX, ev.clientY))
    }
    const onUp = (ev: MouseEvent): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      if (dragging) {
        const g = groupAt(ev.clientX, ev.clientY)
        if (g !== null) {
          const target = g === 'ungrouped' ? undefined : g
          if (target !== w.groupId) moveWorkspaceToGroup(w.id, target)
        }
      }
      // если не таскали — это обычный клик, ничего не перехватываем
      // (карточки/кнопки сами обрабатывают свои onClick)
      setDraggingWsId(undefined)
      setDragOverGroup(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const renderColumn = (ws: Workspace): JSX.Element => {
    // Берём сессии по id из карты (O(1)) вместо .find() по всему массиву.
    const wsSessions = ws.sessionIds
      .map((id) => sessionsById.get(id))
      .filter((s): s is Session => Boolean(s))
    return (
      <div key={ws.id} className={`ov-col${draggingWsId === ws.id ? ' ov-col-dragging' : ''}`}>
        <div
          className="ov-col-head"
          onMouseDown={(e) => startWsDrag(e, ws)}
          title="Перетащи в группу, чтобы переместить"
        >
          <span className="ov-drag-grip" title="Перетащи в группу">⠿</span>
          <EditableName
            className="ov-col-name"
            value={ws.name}
            onCommit={(v) => useStore.getState().renameWorkspace(ws.id, v)}
          />
          <span className="ov-col-count">{wsSessions.length}</span>
          <button
            className="ov-add"
            title="Добавить сессию"
            onClick={() => setAddingTo(addingTo === ws.id ? null : ws.id)}
          >
            ＋
          </button>
        </div>
        <div className="ov-col-folder">{ws.folder.replace(/^\/Users\/[^/]+/, '~')}</div>

        {addingTo === ws.id && (
          <div className="ov-addbox">
            <AddSessionForm workspaceId={ws.id} defaultFolder={ws.folder} onDone={() => setAddingTo(null)} />
          </div>
        )}

        <div className="ov-cards">
          {wsSessions.map((s) => (
            <div
              key={s!.id}
              className={`ov-card status-${s!.status}`}
              onClick={() => openSession(ws.id, s!.id)}
            >
              <div className="ov-card-top">
                <span className="ov-card-agent">{agentName(s!.agentId)}</span>
                <span className={`ov-card-status st-${s!.status}`}>{STATUS_LABEL[s!.status]}</span>
              </div>
              <EditableName
                className="ov-card-title"
                block
                value={s!.title}
                onCommit={(v) => useStore.getState().renameSession(s!.id, v)}
              />
              {s!.branch && <div className="ov-card-branch">⑂ {s!.branch.split('/').pop()}</div>}
              {s!.cloneOf && (
                <button
                  className={`ov-wt-rm${confirmRemove === s!.id ? ' confirm' : ''}`}
                  title="Убрать эту ветку с диска (git worktree remove)"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (confirmRemove === s!.id) {
                      removeWorktreeFor(s!.id)
                      setConfirmRemove(null)
                    } else {
                      setConfirmRemove(s!.id)
                    }
                  }}
                  onBlur={() => setConfirmRemove(null)}
                >
                  {confirmRemove === s!.id ? 'точно убрать ветку?' : '⌫ убрать ветку'}
                </button>
              )}
            </div>
          ))}
          {wsSessions.length === 0 && <div className="ov-card-empty">нет сессий</div>}
        </div>
      </div>
    )
  }

  const ungrouped = workspaces.filter((w) => !w.groupId)

  return (
    <div className="overview">
      <div className="ov-bar">
        <span className="ov-bar-title">Сводка по воркспейсам</span>
        {worktreeStats && worktreeStats.count > 0 && (
          <span
            className={`ov-wt${worktreeStats.overLimit || worktreeStats.diskWarn ? ' warn' : ''}`}
            title={`Своих веток: ${worktreeStats.count} из ${worktreeStats.limit}; на диске ${fmtBytes(worktreeStats.diskBytes)}`}
          >
            ⑂ {worktreeStats.count}/{worktreeStats.limit} · {fmtBytes(worktreeStats.diskBytes)}
          </span>
        )}
        <button className="ws-tb-btn" onClick={() => onNew('')}>
          ＋ воркспейс
        </button>
        {aliveCount > 0 &&
          (confirmKill ? (
            <button
              className="ws-tb-btn danger"
              onClick={() => {
                killAllSessions()
                setConfirmKill(false)
              }}
              onBlur={() => setConfirmKill(false)}
              title="Подтвердить остановку всех агентов"
            >
              точно убить {aliveCount}?
            </button>
          ) : (
            <button
              className="ws-tb-btn"
              onClick={() => setConfirmKill(true)}
              title="Остановить все запущенные агенты (разговор сохранится — можно поднять заново)"
            >
              ⏹ убить всё
            </button>
          ))}
      </div>

      {workspaces.length === 0 && (
        <div className="ov-empty">Пока нет воркспейсов — создай кнопкой «＋ воркспейс».</div>
      )}

      {/* воркспейсы из одной группы — вместе (разная работа по одному проекту) */}
      {groups.map((g) => {
        const wss = workspaces.filter((w) => w.groupId === g.id)
        // при перетаскивании показываем даже пустые группы как зону сброса
        if (wss.length === 0 && !draggingWsId) return null
        return (
          <div
            key={g.id}
            className={`ov-group${dragOverGroup === g.id && draggingWsId ? ' ov-drop-into' : ''}`}
            data-drop-group={g.id}
          >
            <div className="ov-group-head">
              <EditableName
                className="ov-group-name"
                value={g.name}
                onCommit={(v) => useStore.getState().renameGroup(g.id, v)}
              />
              <span className="ov-group-count">{wss.length}</span>
              <button className="ov-add" title={`Новый воркспейс в «${g.name}»`} onClick={() => onNew(g.name)}>
                ＋
              </button>
            </div>
            <div className="ov-columns">
              {wss.map(renderColumn)}
              {draggingWsId && wss.length === 0 && (
                <div className="ov-drop-hint">бросить сюда</div>
              )}
            </div>
          </div>
        )
      })}

      {(ungrouped.length > 0 || draggingWsId) && (
        <div
          className={`ov-group${dragOverGroup === 'ungrouped' && draggingWsId ? ' ov-drop-into' : ''}`}
          data-drop-group="ungrouped"
        >
          <div className="ov-group-head">
            <span className="ov-group-name muted">БЕЗ ГРУППЫ</span>
            <span className="ov-group-count">{ungrouped.length}</span>
            <button className="ov-add" title="Новый воркспейс без группы" onClick={() => onNew('')}>
              ＋
            </button>
          </div>
          <div className="ov-columns">
            {ungrouped.map(renderColumn)}
            {draggingWsId && ungrouped.length === 0 && (
              <div className="ov-drop-hint">бросить сюда — убрать из группы</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
