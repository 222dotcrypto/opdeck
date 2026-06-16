import { useState } from 'react'
import { useStore } from '../store'

// Инлайн-форма «добавить свой CLI»: название + команда запуска.
// После сохранения агент доступен во всех списках выбора.
export default function CustomCliForm({ onDone }: { onDone: () => void }): JSX.Element {
  const addCustomAgent = useStore((s) => s.addCustomAgent)
  const pushToast = useStore((s) => s.pushToast)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    if (!name.trim() || !command.trim()) {
      pushToast('warn', 'Заполни название и команду')
      return
    }
    setBusy(true)
    await addCustomAgent(name.trim(), command.trim())
    setBusy(false)
    onDone()
  }

  return (
    <div className="cli-form">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Название (напр. Aider)"
      />
      <input
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        placeholder="Команда (напр. aider --model gpt-5)"
        onKeyDown={(e) => e.key === 'Enter' && save()}
      />
      <div className="cli-form-actions">
        <button className="btn-ghost sm" onClick={onDone} disabled={busy}>
          Отмена
        </button>
        <button className="btn-primary sm" onClick={save} disabled={busy}>
          Добавить
        </button>
      </div>
    </div>
  )
}
