import type { LayoutId } from '../../../shared/types'

// Описание раскладок панелей: сколько окон и как они расставлены в CSS-сетке.
export interface LayoutDef {
  id: LayoutId
  label: string
  count: number
  cols: string
  rows: string
}

export const LAYOUTS: LayoutDef[] = [
  { id: '1', label: '1 окно', count: 1, cols: '1fr', rows: '1fr' },
  { id: '2v', label: '2 (верх/низ)', count: 2, cols: '1fr', rows: '1fr 1fr' },
  { id: '2h', label: '2 (лево/право)', count: 2, cols: '1fr 1fr', rows: '1fr' },
  { id: '3', label: '3 окна', count: 3, cols: '1fr 1fr', rows: '1fr 1fr' },
  { id: '4', label: 'Сетка 2×2', count: 4, cols: '1fr 1fr', rows: '1fr 1fr' },
  { id: '1x3', label: '3 в ряд', count: 3, cols: '1fr 1fr 1fr', rows: '1fr' },
  { id: '2x3', label: 'Сетка 2×3', count: 6, cols: '1fr 1fr 1fr', rows: '1fr 1fr' },
  { id: '2x4', label: 'Сетка 2×4', count: 8, cols: '1fr 1fr 1fr 1fr', rows: '1fr 1fr' }
]

export function layoutDef(id: LayoutId): LayoutDef {
  // '2x2' убрали из списка (дубль '4') — старые воркспейсы маппим на '4'
  const aliased = id === '2x2' ? '4' : id
  return LAYOUTS.find((l) => l.id === aliased) ?? LAYOUTS[0]
}
