import { useEffect, useRef, useState } from 'react'

interface Props {
  value: string
  onCommit: (next: string) => void
  className?: string
  title?: string
  // block=true → гасим и одиночный клик/нажатие, чтобы они не сработали как действие
  // родителя (открыть сессию/воркспейс, свернуть группу). Нужно там, где клик по
  // контейнеру что-то делает. Где клик безвреден (заголовок панели) — оставляем false,
  // чтобы одиночный клик по-прежнему фокусировал/открывал.
  block?: boolean
}

// Имя, редактируемое по ДВОЙНОМУ клику: двойной клик → поле ввода → Enter или потеря
// фокуса сохраняют, Esc отменяет. Пустое имя не сохраняем. Двойной клик всегда гасим
// (stopPropagation), чтобы не сработал двойной клик родителя (развернуть панель и т.п.).
export default function EditableName({ value, onCommit, className, title, block }: Props): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)
  // защита от двойного завершения: Enter вызывает commit и убирает input, но WKWebView
  // может ещё дослать blur с того же узла → второй commit. Флаг делает повтор no-op.
  const activeRef = useRef(false)

  // фокус + выделение всего текста при входе в правку
  useEffect(() => {
    if (editing) {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.select()
      }
    }
  }, [editing])

  // имя поменялось извне (не во время правки) — подхватываем
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  const commit = (): void => {
    if (!activeRef.current) return
    activeRef.current = false
    const next = draft.trim()
    setEditing(false)
    if (next && next !== value) onCommit(next)
    else setDraft(value)
  }
  const cancel = (): void => {
    if (!activeRef.current) return
    activeRef.current = false
    setDraft(value)
    setEditing(false)
  }
  const beginEdit = (): void => {
    activeRef.current = true
    setEditing(true)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`editable-input ${className ?? ''}`}
        value={draft}
        size={Math.max(draft.length, 3)}
        onChange={(e) => setDraft(e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') cancel()
        }}
      />
    )
  }

  return (
    <span
      className={`editable ${className ?? ''}`}
      title={title ?? 'Двойной клик — переименовать'}
      onMouseDown={block ? (e) => e.stopPropagation() : undefined}
      onClick={block ? (e) => e.stopPropagation() : undefined}
      onDoubleClick={(e) => {
        e.stopPropagation()
        beginEdit()
      }}
    >
      {value}
    </span>
  )
}
