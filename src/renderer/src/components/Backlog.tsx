import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import type { BacklogKind, BacklogStatus, BacklogTask } from '../../../shared/types'

// RFC 0016 — беклог задач. Пятая вкладка рядом с «Ревью»: копим идеи/баги (с тегом и
// скрином), кнопкой «В работу» отправляем задачу первым промтом в новую сессию агента.
// Захват скрина — переиспользуем save_image_bytes (вставка из буфера ИЛИ выбор файла);
// в стейте храним путь к файлу, не байты. Жизненный цикл: draft → sent → done.
//
// Доска по статусам (kanban): три колонки в ряд на всю ширину окна — «Черновик» (draft),
// «В работе» (sent), «Готово» (done). Каждая колонка стопкой держит свои карточки. Статус
// меняется кликом по бейджу → выпадающий список (карточка переезжает в нужную колонку).

// Предопределённые теги (RFC §Решения 4) — человеческие подписи в UI.
const KINDS: { id: BacklogKind; label: string }[] = [
  { id: 'bug', label: 'баг' },
  { id: 'idea', label: 'идея' },
  { id: 'feature', label: 'фича' }
]
const STATUS_LABEL: Record<BacklogStatus, string> = { draft: 'черновик', sent: 'в работе', done: 'готово' }
// статус задачи → готовая статус-палитра пульта (рамка/цвет, как у сессий)
const STATUS_CLASS: Record<BacklogStatus, string> = {
  draft: 'status-idle',
  sent: 'status-working',
  done: 'status-ready'
}
// порядок колонок доски (слева направо) + их заголовки
const COLUMNS: { id: BacklogStatus; label: string }[] = [
  { id: 'draft', label: 'Черновик' },
  { id: 'sent', label: 'В работе' },
  { id: 'done', label: 'Готово' }
]

// Превью одного скрина: читаем файл по пути в data-url (готовый мост fs.readFileDataUrl).
function Thumb({ path, onRemove }: { path: string; onRemove: () => void }): JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    window.api.fs
      .readFileDataUrl(path)
      .then((d) => alive && setSrc(d))
      .catch(() => alive && setSrc(null))
    return () => {
      alive = false
    }
  }, [path])
  return (
    <div className="bl-thumb" title={path}>
      {src ? <img src={src} alt="" /> : <span className="bl-thumb-x">⛶</span>}
      <button className="bl-thumb-rm" title="Убрать скрин" onClick={onRemove}>
        ✕
      </button>
    </div>
  )
}

// Кликабельный бейдж статуса → выпадающий список из трёх статусов. Выбор вызывает
// updateTask(id,{status}) — карточка переезжает в соответствующую колонку доски.
function StatusBadge({ task }: { task: BacklogTask }): JSX.Element {
  const updateTask = useStore((s) => s.updateTask)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // клик вне меню / Esc — закрыть
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (status: BacklogStatus): void => {
    if (status !== task.status) updateTask(task.id, { status })
    setOpen(false)
  }

  return (
    <div className="bl-status-wrap" ref={ref}>
      <button
        className={`bl-status ${task.status}`}
        title="Сменить статус"
        onClick={() => setOpen((v) => !v)}
      >
        {STATUS_LABEL[task.status]} <span className="bl-status-caret">▾</span>
      </button>
      {open && (
        <div className="bl-status-menu">
          {COLUMNS.map((c) => (
            <button
              key={c.id}
              className={`bl-status-opt ${c.id} ${task.status === c.id ? 'sel' : ''}`}
              onClick={() => pick(c.id)}
            >
              {STATUS_LABEL[c.id]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Мини-выбор «В работу»: агент (встроенные + свои CLI) + воркспейс → отправка.
function SendPicker({
  task,
  onDone
}: {
  task: BacklogTask
  onDone: () => void
}): JSX.Element {
  const agents = useStore((s) => s.agents)
  const customAgents = useStore((s) => s.customAgents)
  const workspaces = useStore((s) => s.workspaces)
  const sendTaskToAgent = useStore((s) => s.sendTaskToAgent)

  const pickable = useMemo(
    () => [
      ...agents.filter((a) => a.available && !a.custom),
      ...customAgents.map((c) => ({ id: c.id, name: c.name, custom: true }))
    ],
    [agents, customAgents]
  )

  const [agentId, setAgentId] = useState<string>(pickable[0]?.id ?? 'shell')
  const [wsId, setWsId] = useState<string>(workspaces[0]?.id ?? '')
  const [busy, setBusy] = useState(false)

  const send = async (): Promise<void> => {
    if (!wsId) return
    setBusy(true)
    await sendTaskToAgent(task.id, agentId, wsId)
    setBusy(false)
    onDone()
  }

  return (
    <div className="bl-send">
      <label className="af-label">CLI-агент</label>
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
      <label className="af-label">Воркспейс</label>
      {workspaces.length === 0 ? (
        <div className="bl-hint">Нет воркспейсов — создай хотя бы один (Ctrl+N).</div>
      ) : (
        <select value={wsId} onChange={(e) => setWsId(e.target.value)}>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      )}
      <div className="af-actions">
        <button className="btn-ghost" onClick={onDone} disabled={busy}>
          Отмена
        </button>
        <button className="btn-primary" onClick={send} disabled={busy || !wsId}>
          {busy ? 'Отправляю…' : 'Отправить агенту'}
        </button>
      </div>
    </div>
  )
}

// Одна карточка задачи: правка заголовка/описания, тег, скрины, статус, «В работу», удалить.
function TaskCard({ task }: { task: BacklogTask }): JSX.Element {
  const updateTask = useStore((s) => s.updateTask)
  const deleteTask = useStore((s) => s.deleteTask)
  const pushToast = useStore((s) => s.pushToast)
  const [showSend, setShowSend] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Сохранить картинку из File (вставка/выбор) → путь в attachments. Переиспуем мост
  // save_image_bytes (тот же путь, что у вставки скрина в терминал, TerminalPane).
  const saveImage = async (file: File): Promise<void> => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    const b64 = dataUrl.split(',')[1] ?? ''
    const ext = file.name.includes('.') ? file.name.split('.').pop()! : 'png'
    try {
      const path = await window.api.fs.saveImageBytes(b64, ext)
      updateTask(task.id, { attachments: [...task.attachments, path] })
    } catch {
      pushToast('error', 'Не удалось сохранить скрин')
    }
  }

  // Вставка из буфера (Ctrl/Cmd+V) внутри карточки → если есть картинка, прикрепляем её.
  const onPaste = (e: React.ClipboardEvent): void => {
    const items = e.clipboardData?.items
    if (!items) return
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const f = items[i].getAsFile()
        if (f) {
          e.preventDefault()
          void saveImage(f)
          return
        }
      }
    }
  }

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0]
    if (f) void saveImage(f)
    e.target.value = '' // сброс, чтобы тот же файл можно было выбрать снова
  }

  const removeAttachment = (path: string): void => {
    updateTask(task.id, { attachments: task.attachments.filter((p) => p !== path) })
  }

  return (
    <div className={`bl-card ${STATUS_CLASS[task.status]}`} onPaste={onPaste}>
      <div className="bl-card-top">
        <input
          className="bl-title"
          placeholder="Что сделать…"
          value={task.title}
          onChange={(e) => updateTask(task.id, { title: e.target.value })}
        />
        <button className="bl-del" title="Удалить задачу" onClick={() => deleteTask(task.id)}>
          ✕
        </button>
      </div>

      <textarea
        className="bl-desc"
        rows={2}
        placeholder="Подробности (необязательно)…"
        value={task.description}
        onChange={(e) => updateTask(task.id, { description: e.target.value })}
      />

      <div className="bl-tags">
        {KINDS.map((k) => (
          <button
            key={k.id}
            className={`bl-tag ${task.kind === k.id ? 'sel' : ''}`}
            onClick={() => updateTask(task.id, { kind: k.id })}
          >
            {k.label}
          </button>
        ))}
      </div>

      {task.attachments.length > 0 && (
        <div className="bl-thumbs">
          {task.attachments.map((p) => (
            <Thumb key={p} path={p} onRemove={() => removeAttachment(p)} />
          ))}
        </div>
      )}

      <div className="bl-card-actions">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={onPickFile}
        />
        <StatusBadge task={task} />
        <button
          className="link-btn"
          title="Прикрепить скрин: выбрать файл или вставить из буфера (Ctrl/Cmd+V) в карточку"
          onClick={() => fileInputRef.current?.click()}
        >
          ＋ скрин
        </button>
        {showSend ? null : (
          <button className="btn-primary sm" onClick={() => setShowSend(true)}>
            В работу →
          </button>
        )}
      </div>

      {showSend && <SendPicker task={task} onDone={() => setShowSend(false)} />}
    </div>
  )
}

// Одна колонка доски: заголовок + счётчик, стопка карточек данного статуса.
function StatusColumn({
  status,
  label,
  tasks
}: {
  status: BacklogStatus
  label: string
  tasks: BacklogTask[]
}): JSX.Element {
  const addTask = useStore((s) => s.addTask)
  return (
    <div className={`bl-col ${STATUS_CLASS[status]}`}>
      <div className="bl-col-head">
        <span className="bl-col-name">{label}</span>
        <span className="bl-col-count">{tasks.length}</span>
        <button
          className="bl-col-add"
          title={`Добавить задачу в «${label}»`}
          onClick={() => addTask({ status })}
        >
          ＋
        </button>
      </div>
      <div className="bl-col-cards">
        {tasks.length === 0 ? (
          <div className="bl-col-empty">Пусто</div>
        ) : (
          tasks.map((t) => <TaskCard key={t.id} task={t} />)
        )}
      </div>
    </div>
  )
}

export default function Backlog(): JSX.Element {
  const tasks = useStore((s) => s.tasks)
  const addTask = useStore((s) => s.addTask)
  const [quick, setQuick] = useState('')

  const add = (): void => {
    const title = quick.trim()
    // новая задача — черновик (дефолт addTask), появится в колонке «Черновик»
    addTask(title ? { title } : undefined)
    setQuick('')
  }

  // раскладываем задачи по статусам (порядок внутри колонки сохраняем как в сторе)
  const byStatus = useMemo(() => {
    const map: Record<BacklogStatus, BacklogTask[]> = { draft: [], sent: [], done: [] }
    for (const t of tasks) map[t.status].push(t)
    return map
  }, [tasks])

  return (
    <div className="backlog">
      <div className="ov-bar">
        <span className="ov-bar-title">Задачи</span>
        <span className="ov-wt" title="всего задач в беклоге">
          {tasks.length} шт.
        </span>
      </div>

      <div className="bl-add">
        <input
          id="backlog-quick-input"
          placeholder="Впиши задачу и нажми Enter…"
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="btn-primary icon" title="Добавить задачу (Ctrl+Shift+C)" onClick={add}>
          ＋
        </button>
      </div>

      <div className="bl-board">
        {COLUMNS.map((c) => (
          <StatusColumn key={c.id} status={c.id} label={c.label} tasks={byStatus[c.id]} />
        ))}
      </div>
    </div>
  )
}
