import { Fragment } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import type { Session } from '../../../shared/types'
import TerminalPane from './TerminalPane'

interface Props {
  sessions: Session[]
  cols?: number // ручное число столбцов; undefined = авто
  maximizedId?: string
  onMaximize: (id: string) => void
  onRestore: () => void
  onAdd: () => void
  onSplit: (afterId: string, dir: 'right' | 'down') => void
}

// Сетка ровно по числу окон. Раскладка: авто (≈квадрат) или заданное число столбцов.
// Добавление — кнопкой «＋ окно» в тулбаре; «✕» убирает. Большая ячейка «добавить» —
// только когда окон нет совсем.
export default function PanelGrid({
  sessions,
  cols,
  maximizedId,
  onMaximize,
  onRestore,
  onAdd,
  onSplit
}: Props): JSX.Element {
  if (maximizedId) {
    const s = sessions.find((x) => x.id === maximizedId)
    if (s)
      return (
        <div className="panes-full">
          <TerminalPane session={s} maximized onToggleMax={onRestore} />
        </div>
      )
  }

  if (sessions.length === 0) {
    return (
      <div className="panes-full">
        <div className="pane-empty" onClick={onAdd}>
          <span>＋ добавить окно</span>
        </div>
      </div>
    )
  }

  const total = sessions.length
  const colsN = Math.max(1, Math.min(cols ?? Math.ceil(Math.sqrt(total)), total))
  const rows = Math.ceil(total / colsN)

  // Уникальные id групп/панелей — иначе react-resizable-panels путает соседние ряды
  // (визуально это выглядело как «инвертированный» ползунок).
  return (
    <PanelGroup
      key={`grid-${colsN}-${rows}`}
      id={`grid-v-${colsN}x${rows}`}
      direction="vertical"
      className="pg-root"
    >
      {Array.from({ length: rows }).map((_, r) => {
        const rowItems = sessions.slice(r * colsN, (r + 1) * colsN)
        return (
          <Fragment key={r}>
            <Panel id={`row-${r}`} order={r} minSize={12} className="pg-row-panel">
              <PanelGroup id={`grid-h-${r}-${colsN}`} direction="horizontal">
                {rowItems.map((s, c) => (
                  <Fragment key={s.id}>
                    <Panel id={`cell-${r}-${c}`} order={c} minSize={12} className="pg-cell">
                      <TerminalPane
                        session={s}
                        onToggleMax={() => onMaximize(s.id)}
                        onSplitRight={() => onSplit(s.id, 'right')}
                        onSplitDown={() => onSplit(s.id, 'down')}
                      />
                    </Panel>
                    {c < rowItems.length - 1 && (
                      <PanelResizeHandle id={`h-${r}-${c}`} className="rz rz-v" />
                    )}
                  </Fragment>
                ))}
              </PanelGroup>
            </Panel>
            {r < rows - 1 && <PanelResizeHandle id={`v-${r}`} className="rz rz-h" />}
          </Fragment>
        )
      })}
    </PanelGroup>
  )
}
