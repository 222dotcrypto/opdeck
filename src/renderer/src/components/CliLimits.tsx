import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import claudeLogo from '../assets/cli-icons/claude.svg'
import codexLogo from '../assets/cli-icons/codex.svg'
import grokLogo from '../assets/cli-icons/grok.svg'
import geminiLogo from '../assets/cli-icons/gemini.svg'
import opencodeLogo from '../assets/cli-icons/opencode.svg'
import cursorLogo from '../assets/cli-icons/cursor.svg'
import qwenLogo from '../assets/cli-icons/qwen.svg'

// PLAN 0004 Фаза D — виджет лимитов CLI в верхней панели (Titlebar), справа перед кнопкой «скрыть
// файлы». Логотип + синий бар + значение, без слов. Закреплённые наверху; всё остальное в окне по
// КЛИКУ (тумблер 5ч/7д + все установленные CLI + «＋» закрепить).
// Проценты — НАСТОЯЩИЕ, как в терминале: Claude/Codex отдают остаток квоты сами (rate_limits),
// ничего вписывать не надо. Где % нет (расход читаем, лимита нет) — токены; где CLI установлен, но
// расход не читаем — «—».

type CliWin = { pct: number; used: number; hasPct: boolean; resetInMin: number; windowMin: number }
type CliReport = { id: string; name: string; hasData: boolean; w5: CliWin; w7: CliWin }

const LOGO: Record<string, string> = {
  claude: claudeLogo, codex: codexLogo, grok: grokLogo, gemini: geminiLogo,
  opencode: opencodeLogo, cursor: cursorLogo, qwen: qwenLogo
}
const PIN_KEY = 'deck.cliPinned'
const WIN_KEY = 'deck.cliWindow'

function readPinned(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PIN_KEY) || 'null')
    if (Array.isArray(v)) return v
  } catch {
    /* ignore */
  }
  return ['claude', 'codex'] // по умолчанию закреплены
}

// Компактная запись числа токенов: 1.2M / 340k / 980.
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M'
  if (n >= 1_000) return Math.round(n / 1_000) + 'k'
  return String(n)
}
// «сброс через …»: минуты → часы.
function fmtReset(min: number): string {
  if (!min || min <= 0) return ''
  if (min < 60) return '<1ч'
  const h = Math.round(min / 60)
  return h < 48 ? `${h}ч` : `${Math.round(h / 24)}д`
}
// Длина окна источника человеку: 300→5ч, 10080→7д, 43200→30д.
function fmtWin(min: number): string {
  if (!min || min <= 0) return ''
  if (min < 60) return `${min}м`
  if (min < 1440) return `${Math.round(min / 60)}ч`
  return `${Math.round(min / 1440)}д`
}

// Поверхностное сравнение одного окна (5ч/7д) лимита.
function sameWin(a: CliWin, b: CliWin): boolean {
  return (
    a.pct === b.pct &&
    a.used === b.used &&
    a.hasPct === b.hasPct &&
    a.resetInMin === b.resetInMin &&
    a.windowMin === b.windowMin
  )
}
// perf: одинаковы ли два отчёта по существу — чтобы не дёргать setReports на идентичных данных.
function sameReports(a: CliReport[], b: CliReport[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.hasData !== y.hasData ||
      !sameWin(x.w5, y.w5) ||
      !sameWin(x.w7, y.w7)
    ) {
      return false
    }
  }
  return true
}

export default function CliLimits(): JSX.Element | null {
  const [reports, setReports] = useState<CliReport[]>([])
  const [win, setWin] = useState<'w5' | 'w7'>(() => (localStorage.getItem(WIN_KEY) === 'w7' ? 'w7' : 'w5'))
  const [pinned, setPinned] = useState<string[]>(readPinned)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      invoke<CliReport[]>('usage_snapshot')
        .then((r) => {
          if (!alive) return
          // perf: не плодим новую ссылку массива каждый опрос — обновляем state ТОЛЬКО
          // когда данные реально поменялись (иначе лишние ре-рендеры раз в 30с впустую).
          setReports((prev) => (sameReports(prev, r) ? prev : r))
        })
        .catch(() => { /* нет данных — виджет просто пустой */ })
    }
    load()
    let t = window.setInterval(load, 30000)
    // visibility-pause: окно в фоне → опрос не нужен (квота не наша забота, пока не смотрят).
    // Вернулись на вкладку → сразу освежаем и снова запускаем интервал.
    const onVis = (): void => {
      if (document.visibilityState === 'hidden') {
        clearInterval(t)
        t = 0
      } else {
        if (!t) t = window.setInterval(load, 30000)
        load()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    // если эффект смонтировался уже в фоне — не держим лишний интервал
    if (document.visibilityState === 'hidden') {
      clearInterval(t)
      t = 0
    }
    return () => {
      alive = false
      if (t) clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  // клик вне виджета закрывает окно
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const setWindow = (w: 'w5' | 'w7'): void => {
    setWin(w)
    localStorage.setItem(WIN_KEY, w)
  }
  const togglePin = (id: string): void => {
    setPinned((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      localStorage.setItem(PIN_KEY, JSON.stringify(next))
      return next
    })
  }

  if (!reports.length) return null

  const cw = (r: CliReport): CliWin => (win === 'w5' ? r.w5 : r.w7)
  // значение справа: «—» если расход не читаем; «N%» если есть настоящий %; иначе токены
  const value = (r: CliReport): string => {
    if (!r.hasData) return '—'
    const x = cw(r)
    return x.hasPct ? Math.round(x.pct * 100) + '%' : fmtTokens(x.used)
  }
  const barW = (r: CliReport): number => {
    const x = cw(r)
    return x.hasPct ? Math.min(100, Math.round(x.pct * 100)) : 0
  }
  const bar = (r: CliReport): JSX.Element => (
    <span className="cl-bar"><span className="cl-fill" style={{ width: barW(r) + '%' }} /></span>
  )
  const logo = (r: CliReport): JSX.Element => (
    <img className="cl-lg" src={LOGO[r.id] || ''} title={r.name} alt="" />
  )

  const pins = reports.filter((r) => pinned.includes(r.id))

  return (
    <div className={`cl-lims${open ? ' open' : ''}`} ref={rootRef}>
      <button className="cl-head" onClick={() => setOpen((o) => !o)} title="Лимиты CLI">
        <div className="cl-chips">
          {pins.length === 0 && <span className="cl-empty">лимиты</span>}
          {pins.map((r) => (
            <div className="cl-chip" key={r.id}>{logo(r)}{bar(r)}<span className="cl-pct">{value(r)}</span></div>
          ))}
        </div>
        <span className="cl-cv">▾</span>
      </button>

      {open && (
        <div className="cl-pop">
          <div className="cl-pop-row">
            <span className="cl-t">Лимиты CLI</span>
            <div className="cl-seg">
              <button className={win === 'w5' ? 'on' : ''} onClick={() => setWindow('w5')}>5ч</button>
              <button className={win === 'w7' ? 'on' : ''} onClick={() => setWindow('w7')}>7д</button>
            </div>
          </div>

          {reports.map((r) => {
            const on = pinned.includes(r.id)
            const x = cw(r)
            // фактическое окно источника; если оно не совпадает с выбранным горизонтом — подписываем
            const winLbl = x.hasPct ? fmtWin(x.windowMin) : ''
            const expected = win === 'w5' ? '5ч' : '7д'
            const showWin = winLbl !== '' && winLbl !== expected
            const reset = x.hasPct ? fmtReset(x.resetInMin) : ''
            const meta = [showWin ? winLbl : '', reset].filter(Boolean).join(' · ')
            return (
              <div className="cl-row" key={r.id}>
                {logo(r)}
                <span className="cl-nm">{r.name}</span>
                {bar(r)}
                <span className="cl-pct" title={r.hasData ? `${fmtTokens(x.used)} токенов в окне` : 'остаток пока не читается'}>
                  {value(r)}
                </span>
                <span className="cl-rst" title={showWin ? `реальное окно лимита: ${winLbl}` : ''}>{meta}</span>
                <button
                  className={`cl-pin${on ? ' on' : ''}`}
                  title={on ? 'Убрать сверху' : 'Закрепить сверху'}
                  onClick={() => togglePin(r.id)}
                >
                  {on ? '✓' : '＋'}
                </button>
              </div>
            )
          })}

          <div className="cl-foot" title="Проценты приходят сами от Claude/Codex — как в терминале">
            <span style={{ fontSize: 12 }}>✓</span>
            <span>Остаток обновляется автоматически</span>
          </div>
        </div>
      )}
    </div>
  )
}
