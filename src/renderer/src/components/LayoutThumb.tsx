import { layoutDef } from './layouts'
import type { LayoutId } from '../../../shared/types'

// Мини-схема раскладки: рисуем ячейки сетки, как они будут на экране.
export default function LayoutThumb({
  id,
  selected,
  onClick
}: {
  id: LayoutId
  selected: boolean
  onClick: () => void
}): JSX.Element {
  const def = layoutDef(id)
  return (
    <button className={`nw-thumb ${selected ? 'sel' : ''}`} onClick={onClick} title={def.label}>
      <span
        className="nw-thumb-grid"
        style={{ gridTemplateColumns: def.cols, gridTemplateRows: def.rows }}
      >
        {Array.from({ length: def.count }).map((_, i) => (
          <span key={i} className="nw-thumb-cell" />
        ))}
      </span>
    </button>
  )
}

// Число столбцов в раскладке (для ручной сетки воркспейса).
export function colsOfLayout(id: LayoutId): number {
  return layoutDef(id).cols.split(' ').length
}
