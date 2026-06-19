import { useEffect } from 'react'
import { useStore } from '../store'

// Всплывающее окошко со ВСЕМИ горячими клавишами (как ⓘ в редакторе): рендерится
// у кнопки ⓘ в шапке. Открывается кнопкой или комбо Cmd/Ctrl + «/».
type Row = { keys: string[]; desc: string }
type Group = { title: string; rows: Row[] }

const GROUPS: Group[] = [
  {
    title: 'Навигация',
    rows: [
      { keys: ['⌘/Ctrl', 'K'], desc: 'Командная палитра — быстрый поиск действий' },
      { keys: ['⌘/Ctrl', '⇧ Shift', 'U'], desc: 'Прыжок к работающей / ждущей сессии' },
      { keys: ['⌘/Ctrl', '/'], desc: 'Открыть это окно горячих клавиш' },
    ],
  },
  {
    title: 'Воркспейсы',
    rows: [
      { keys: ['⌘/Ctrl', 'N'], desc: 'Новый воркспейс' },
      { keys: ['⌘/Ctrl', '1 … 9'], desc: 'Переключиться на воркспейс по номеру' },
    ],
  },
  {
    title: 'Задачи',
    rows: [{ keys: ['⌘/Ctrl', '⇧ Shift', 'C'], desc: 'Открыть «Задачи» и ввод новой задачи' }],
  },
  {
    title: 'Редактор кода',
    rows: [
      { keys: ['⌘/Ctrl', 'S'], desc: 'Сохранить файл' },
      { keys: ['⌥ Option', '+ клик'], desc: 'Поставить ещё один курсор' },
      { keys: ['⌥ Option', '⇧ Shift', '+ протянуть'], desc: 'Курсоры в столбик' },
      { keys: ['⌘ Cmd', '⌥ Option', '['], desc: 'Свернуть весь код' },
      { keys: ['⌘ Cmd', '⌥ Option', ']'], desc: 'Развернуть весь код' },
    ],
  },
  {
    title: 'Окна',
    rows: [{ keys: ['Esc'], desc: 'Закрыть окошко, палитру или меню' }],
  },
]

export default function ShortcutsModal(): JSX.Element {
  const close = (): void => useStore.getState().setShortcutsOpen(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <>
      <div className="sc-backdrop" onClick={close} />
      <div className="sc-pop" role="dialog">
        <div className="sc-pop-title">Горячие клавиши</div>
        {GROUPS.map((g) => (
          <div key={g.title} className="sc-group">
            <div className="sc-group-title">{g.title}</div>
            {g.rows.map((r, i) => (
              <div key={i} className="sc-row">
                <span className="sc-keys">
                  {r.keys.map((k, j) => (
                    <kbd key={j}>{k}</kbd>
                  ))}
                </span>
                <span className="sc-desc">{r.desc}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}
