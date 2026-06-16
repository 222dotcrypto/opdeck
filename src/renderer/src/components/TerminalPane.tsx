import { memo, useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { Session, SessionStatus } from '../../../shared/types'
import { useStore } from '../store'
import EditableName from './EditableName'

const STATUS_LABEL: Record<SessionStatus, string> = {
  ready: 'готов',
  working: 'работает',
  awaiting: 'ждёт ответа',
  error: 'ошибка',
  idle: 'простаивает'
}

const XTERM_THEME = {
  background: '#16161a',
  foreground: '#d6d6dd',
  cursor: '#d6d6dd',
  selectionBackground: '#3a3a45',
  black: '#16161a',
  brightBlack: '#6b6b76'
}

interface PaneProps {
  session: Session
  maximized?: boolean
  onToggleMax?: () => void
  onSplitRight?: () => void
  onSplitDown?: () => void
}

// Иконка «развернуть на весь экран» — две стрелки расходятся в углы.
const IconExpand = (): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </svg>
)

// Иконка «свернуть» — две стрелки сходятся к центру.
const IconShrink = (): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 14 10 14 10 20" />
    <polyline points="20 10 14 10 14 4" />
    <line x1="14" y1="10" x2="21" y2="3" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </svg>
)

// Иконка «разделить вправо» — рамка с вертикальной перегородкой (окна бок о бок).
const IconSplitRight = (): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="12" y1="4" x2="12" y2="20" />
  </svg>
)

// Иконка «разделить вниз» — рамка с горизонтальной перегородкой (окна стопкой).
const IconSplitDown = (): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="3" y1="12" x2="21" y2="12" />
  </svg>
)

function TerminalPane({
  session,
  maximized,
  onToggleMax,
  onSplitRight,
  onSplitDown
}: PaneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const setFocused = useStore((s) => s.setFocused)
  const focused = useStore((s) => s.focusedSessionId === session.id)
  const agents = useStore((s) => s.agents)
  const draggingId = useStore((s) => s.draggingSessionId)
  const dragOverId = useStore((s) => s.dragOverSessionId)
  const agentName = agents.find((a) => a.id === session.agentId)?.name ?? session.agentId

  const isDragSource = draggingId === session.id
  const isDropTarget = dragOverId === session.id && draggingId !== session.id

  // Ручное перетаскивание мышью (HTML5-DnD не работает в WKWebView Tauri):
  // тянем за шапку → отслеживаем курсор → бросаем на другое окно.
  const startDrag = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    // клик по редактируемому имени сессии — не перетаскивание (не перехватываем фокус у поля ввода)
    if ((e.target as HTMLElement).closest('.editable, .editable-input')) return
    const st = useStore.getState()
    setFocused(session.id)
    termRef.current?.focus()
    const sx = e.clientX
    const sy = e.clientY
    let dragging = false

    const onMove = (ev: MouseEvent): void => {
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) {
        dragging = true
        st.setDragging(session.id)
        document.body.style.cursor = 'grabbing'
      }
      if (dragging) {
        const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest(
          '.pane'
        )
        const tid = el?.getAttribute('data-session-id') || undefined
        st.setDragOver(tid && tid !== session.id ? tid : undefined)
      }
    }
    const onUp = (ev: MouseEvent): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      if (dragging) {
        const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest(
          '.pane'
        )
        const tid = el?.getAttribute('data-session-id') || undefined
        if (tid && tid !== session.id) st.moveSession(session.workspaceId, session.id, tid)
      }
      st.setDragging(undefined)
      st.setDragOver(undefined)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  useEffect(() => {
    if (!containerRef.current) return
    const containerEl = containerRef.current
    const term = new Terminal({
      fontFamily: 'Menlo, "SF Mono", monospace',
      fontSize: 12.5,
      cursorBlink: true,
      theme: XTERM_THEME,
      allowProposedApi: true,
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)
    termRef.current = term
    fitRef.current = fit

    // Кликабельные ссылки на файлы: путь в выводе → открыть в редакторе.
    const openFileRef = async (token: string): Promise<void> => {
      const rel = token.replace(/(:\d+)+$/, '') // убираем :строка:столбец
      const name = rel.split('/').pop() || rel
      // ядро резолвит путь: прямой от cwd; если файла нет — ищет по имени в воркспейсе
      const path = await window.api.fs.resolve(session.cwd, rel)
      useStore.getState().selectFile({ path, name })
    }
    const PATH_RE = /(?:\.{0,2}\/)?[\w.\-]+(?:\/[\w.\-]+)*\.[A-Za-z][\w]{0,9}(?::\d+)*/g
    const linkDisp = term.registerLinkProvider({
      provideLinks(lineNum, callback) {
        try {
          const buf = term.buffer.active
          const first = buf.getLine(lineNum - 1)
          if (!first) return callback(undefined)
          // Длинный путь, не влезший в ширину, xterm переносит на следующие строки
          // (line.isWrapped=true). Ссылки отдаём ТОЛЬКО с первой строки группы, склеив
          // её с продолжениями → путь, разбитый переносом, остаётся одной кликабельной
          // ссылкой (раньше детектор видел только обрывок на второй строке).
          if (first.isWrapped) return callback(undefined)
          const cols = term.cols
          // translateToString(false) — без обрезки, каждая строка ровно cols символов,
          // тогда плоский индекс → (x,y) считается делением на cols без сдвигов.
          let text = first.translateToString(false)
          let rows = 1
          let cont = buf.getLine(lineNum - 1 + rows)
          while (cont && cont.isWrapped) {
            text += cont.translateToString(false)
            rows++
            cont = buf.getLine(lineNum - 1 + rows)
          }
          const links: import('@xterm/xterm').ILink[] = []
          let m: RegExpExecArray | null
          PATH_RE.lastIndex = 0
          while ((m = PATH_RE.exec(text))) {
            const matched = m[0]
            const flatStart = m.index
            const flatEnd = m.index + matched.length - 1
            links.push({
              range: {
                start: { x: (flatStart % cols) + 1, y: lineNum + Math.floor(flatStart / cols) },
                end: { x: (flatEnd % cols) + 1, y: lineNum + Math.floor(flatEnd / cols) }
              },
              text: matched,
              activate: () => openFileRef(matched)
            })
          }
          callback(links.length ? links : undefined)
        } catch {
          callback(undefined)
        }
      }
    })

    // Безопасный подгон размера: только когда контейнер реально виден и измерен,
    // иначе xterm падает с «reading dimensions».
    const safeFit = (): void => {
      const el = containerRef.current
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        /* рендерер терминала ещё не готов */
      }
    }

    // Восстановление истории: пока не залили буфер — копим живой вывод в очередь,
    // чтобы ничего не потерять и не задвоить.
    let hydrated = false
    const pending: string[] = []
    // Батч живого вывода: ptyData копит куски в одну строку, пишем ОДНИМ term.write
    // через requestAnimationFrame. Пока окно спрятано (1A) вебвью усыплён и rAF почти
    // не тикает → вывод копится и выливается одним батчем на возврате окна, а НЕ сотнями
    // мелких term.write подряд (это давало фриз «не отвечает» на пару секунд). Заодно
    // склейка вывода из RFC 0006. Очередь ограничена — на случай долгого скрытия (память
    // и длительность одного батча не растут; терминал всё равно режет скроллбэк).
    const MAX_QUEUE = 400_000
    let writeQueue = ''
    let flushRaf = 0
    const flush = (): void => {
      flushRaf = 0
      if (!writeQueue) return
      term.write(writeQueue)
      writeQueue = ''
    }
    const queueWrite = (data: string): void => {
      writeQueue += data
      if (writeQueue.length > MAX_QUEUE) writeQueue = writeQueue.slice(-MAX_QUEUE)
      if (!flushRaf) flushRaf = requestAnimationFrame(flush)
    }

    // первый подгон — после кадра отрисовки, когда размеры посчитаны
    const raf = requestAnimationFrame(async () => {
      safeFit()
      window.api.pty.resize(session.id, term.cols, term.rows)
      // авто-возрождение: если PTY не жив (после перезапуска приложения) — запускаем
      const alive = await window.api.session.isAlive(session.id)
      if (!alive) window.api.session.start(session)
      // восстановить ранее показанный вывод (для любого агента)
      const buf = await window.api.pty.buffer(session.id)
      if (buf) term.write(buf)
      pending.forEach((d) => term.write(d))
      pending.length = 0
      hydrated = true
      safeFit()
      // если это окно активно (открыли из «Сводки»/сайдбара) — фокус после загрузки буфера
      if (useStore.getState().focusedSessionId === session.id) term.focus()
    })

    term.onData((data) => window.api.pty.write(session.id, data))
    // На КАЖДУЮ отправку промта (Enter без Shift/Alt) шлём «юзер ответил»: первый раз
    // включает отслеживание статуса, а каждый раз — мгновенно красит сессию в синий
    // «работает», не дожидаясь хука агента. Раньше слали только на первый Enter → после
    // ответа жёлтый «ждёт» висел до следующего хука (заметный лаг).
    // (Shift/Alt+Enter — перенос строки в агенте, не отправка → не считаем.)
    term.onKey(({ domEvent }) => {
      if (domEvent.key === 'Enter' && !domEvent.shiftKey && !domEvent.altKey) {
        window.api.session.userTyped(session.id)
      }
    })
    term.onResize(({ cols, rows }) => window.api.pty.resize(session.id, cols, rows))

    // вывод процесса → терминал (фильтруем по нашей сессии)
    const off = window.api.on.ptyData((sid, data) => {
      if (sid !== session.id) return
      if (hydrated) queueWrite(data)
      else pending.push(data)
    })

    // Вставка через cmd+v. Два случая:
    //  1) скопирован файл/папка в Finder → вписываем РЕАЛЬНЫЙ путь (для папки тоже).
    //     Путь из браузерного буфера в WKWebView недоступен (для папки File = null),
    //     поэтому берём нативно через ядро (clipboard.filePaths).
    //  2) скриншот в буфере = только байты (пути нет) → сохраняем во временный файл,
    //     вписываем путь к нему (агенты читают вложение по пути).
    const onPaste = (e: ClipboardEvent): void => {
      const items = e.clipboardData?.items
      if (!items) return
      let hasFileItem = false
      let imageFile: File | null = null
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          hasFileItem = true
          const f = items[i].getAsFile() // картинка → File; папка → null
          if (f && !imageFile) imageFile = f
        }
      }
      if (!hasFileItem) return // обычный текст → xterm вставит сам
      e.preventDefault()
      e.stopPropagation()
      const insert = (text: string): void => window.api.pty.write(session.id, text)
      const quote = (p: string): string => `'${p.replace(/'/g, "'\\''")}'`
      ;(async () => {
        // 1) реальные пути файлов/папок из буфера
        try {
          const paths = await window.api.clipboard.filePaths()
          if (paths && paths.length) {
            insert(paths.map(quote).join(' ') + ' ')
            return
          }
        } catch {
          /* нет нативного чтения буфера — идём дальше */
        }
        // 2) байты картинки → временный файл
        if (!imageFile) return
        const reader = new FileReader()
        reader.onload = async () => {
          const dataUrl = String(reader.result)
          const b64 = dataUrl.split(',')[1] ?? ''
          const ext = imageFile!.name.includes('.') ? imageFile!.name.split('.').pop()! : 'png'
          try {
            const path = await window.api.fs.saveImageBytes(b64, ext)
            insert(path + ' ')
          } catch {
            /* не удалось сохранить — игнор */
          }
        }
        reader.readAsDataURL(imageFile)
      })()
    }
    containerEl.addEventListener('paste', onPaste, true)

    const ro = new ResizeObserver(() => safeFit())
    ro.observe(containerRef.current)

    return () => {
      cancelAnimationFrame(raf)
      if (flushRaf) cancelAnimationFrame(flushRaf)
      off()
      ro.disconnect()
      containerEl.removeEventListener('paste', onPaste, true)
      linkDisp.dispose()
      term.dispose()
      termRef.current = null
    }
  }, [session.id])

  // Фокус на терминал при активации сессии (открытие из «Сводки», сайдбара, горячей
  // клавиши) — а не только по клику мышью. Иначе первый набранный промт уходит мимо
  // терминала (в document.body). Небольшая задержка — ждём, пока панель после смены
  // вкладки реально появится и xterm-textarea станет фокусируемой.
  useEffect(() => {
    if (!focused) return
    const t = setTimeout(() => termRef.current?.focus(), 60)
    return () => clearTimeout(t)
  }, [focused])

  return (
    <div
      data-session-id={session.id}
      className={`pane status-${session.status} ${focused ? 'focused' : ''} ${isDropTarget ? 'drop-over' : ''} ${isDragSource ? 'drag-source' : ''}`}
      onMouseDown={() => {
        setFocused(session.id)
        termRef.current?.focus()
      }}
    >
      <div
        className="pane-head"
        onMouseDown={startDrag}
        onDoubleClick={() => onToggleMax?.()}
        title="Потяни за шапку, чтобы переставить окно"
      >
        <span className="pane-dot" />
        <EditableName
          className="pane-title"
          value={session.title}
          onCommit={(v) => useStore.getState().renameSession(session.id, v)}
        />
        <span className="pane-agent">{agentName}</span>
        {session.branch && <span className="pane-branch">⑂ {session.branch.split('/').pop()}</span>}
        <span className="pane-status">{STATUS_LABEL[session.status]}</span>
        {session.stalled && (
          <span className="pane-stalled" title="Похоже, агент зациклился (вывод не меняется)">
            ⚠
          </span>
        )}
        {(session.status === 'error' || session.stalled) && (
          <button
            className="pane-btn pane-btn-icon restart"
            title={session.stalled ? 'Агент завис/зациклился — перезапустить' : 'Сессия упала — перезапустить'}
            onClick={(e) => {
              e.stopPropagation()
              useStore.getState().restartSession(session.id)
            }}
          >
            ↻
          </button>
        )}
        {onSplitRight && (
          <button
            className="pane-btn pane-btn-icon"
            title="Разделить: новое окно справа"
            onClick={(e) => {
              e.stopPropagation()
              onSplitRight()
            }}
          >
            <IconSplitRight />
          </button>
        )}
        {onSplitDown && (
          <button
            className="pane-btn pane-btn-icon"
            title="Разделить: новое окно снизу"
            onClick={(e) => {
              e.stopPropagation()
              onSplitDown()
            }}
          >
            <IconSplitDown />
          </button>
        )}
        {onToggleMax && (
          <button
            className="pane-btn pane-btn-icon"
            title={maximized ? 'Свернуть' : 'На весь экран'}
            onClick={(e) => {
              e.stopPropagation()
              onToggleMax()
            }}
          >
            {maximized ? <IconShrink /> : <IconExpand />}
          </button>
        )}
        <button
          className="pane-x"
          title="Закрыть"
          onClick={(e) => {
            e.stopPropagation()
            useStore.getState().removeSession(session.id)
          }}
        >
          ✕
        </button>
      </div>
      <div className="pane-term" ref={containerRef} />
      {isDropTarget && (
        <div className="pane-drop-zone over">
          <span>↘ поставить сюда</span>
        </div>
      )}
    </div>
  )
}

// Перерисовываем панель только при смене значимых полей сессии или maximized.
// Колбэки родитель пересоздаёт каждый рендер — их игнорируем. Фокус/перетаскивание
// панель берёт из store сама. Итог: статус одной сессии не перерисовывает все окна.
function areEqual(prev: PaneProps, next: PaneProps): boolean {
  return (
    prev.session.id === next.session.id &&
    prev.session.status === next.session.status &&
    prev.session.title === next.session.title &&
    prev.session.branch === next.session.branch &&
    prev.session.agentId === next.session.agentId &&
    prev.maximized === next.maximized
  )
}

export default memo(TerminalPane, areEqual)
