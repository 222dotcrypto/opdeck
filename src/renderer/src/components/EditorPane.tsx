import { useCallback, useEffect, useRef, useState } from 'react'
import Editor, { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
// Реальный воркер monaco (Vite соберёт его как отдельный worker-бандл). ИМЕННО он
// считает diff — без него разница не вычисляется.
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import { marked } from 'marked'
import { useStore, diffSourceFolder } from '../store'

// Папка файла из POSIX-пути.
function dirOf(p: string): string {
  return p.slice(0, p.lastIndexOf('/'))
}

// Резолв относительного пути (./ и ../) в абсолютный POSIX-путь.
function resolvePath(baseDir: string, rel: string): string {
  const out: string[] = []
  for (const seg of (baseDir + '/' + rel).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

// Локальный Monaco (без интернета). РЕАЛЬНЫЙ editor.worker — он и считает diff.
// Раньше тут был пустой Blob-worker «только для подсветки» → расчёт разницы (он идёт
// в этом воркере) НИКОГДА не выполнялся, и diff залипал на «всё одинаково» (особенно
// для реально изменённых файлов; новый/пустой файл считался на главном потоке и работал).
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker()
}
loader.config({ monaco })

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  json: 'json', md: 'markdown', py: 'python', rs: 'rust', go: 'go',
  toml: 'ini', yml: 'yaml', yaml: 'yaml', sh: 'shell', css: 'css', html: 'html',
  sql: 'sql', txt: 'plaintext'
}

function langOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return EXT_LANG[ext] ?? 'plaintext'
}

// Короткий хеш строки (djb2) — для key DiffEditor: пересобрать редактор только когда
// содержимое «было/стало» реально изменилось (после правки/сохранения), иначе тот же key.
function hashText(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return h
}

// Чёткие иконки развернуть/свернуть (диагональные стрелки), рисуем SVG — рендерятся одинаково везде.
function ExpandIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">
      <path d="M2 2h5L5 4l3 3-1 1-3-3-2 2V2zM14 14H9l2-2-3-3 1-1 3 3 2-2v5z" />
    </svg>
  )
}
function CollapseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">
      <path d="M7 7H2l2-2-3-3 1-1 3 3 2-2v5zM9 9h5l-2 2 3 3-1 1-3-3-2 2V9z" />
    </svg>
  )
}

// RFC 0011: diff на ЧИСТОМ monaco (без обёртки @monaco-editor/react). Обёртка монтировала
// пустые модели и обновляла их через setValue — в monaco 0.52 diff после setValue не
// пересчитывается, поэтому package.json залипал на «всё одинаково». Здесь модели создаются
// СРАЗУ с текстом и ставятся через setModel (надёжно пересчитывает разницу), редактор живёт
// один монтаж, а пересборка при смене содержимого — через key у родителя.
function InlineDiff({
  original,
  modified,
  language
}: {
  original: string
  modified: string
  language: string
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const ed = monaco.editor.createDiffEditor(host, {
      readOnly: true,
      renderSideBySide: false, // одна колонка ВСЕГДА (red «было» сверху, green «стало» снизу)
      fontSize: 12.5,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      renderOverviewRuler: false,
      overviewRulerLanes: 0,
      wordWrap: 'on',
      diffWordWrap: 'on',
      hideUnchangedRegions: { enabled: true }, // сворачиваем неизменённые куски
      lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off }, // убрать значок-лампу (code actions)
      scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9, useShadows: false },
      lineNumbersMinChars: 3,
      theme: 'vs-dark'
    })
    const o = monaco.editor.createModel(original, language)
    const m = monaco.editor.createModel(modified, language)
    ed.setModel({ original: o, modified: m })
    return () => {
      ed.dispose()
      o.dispose()
      m.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div ref={hostRef} style={{ height: '100%', width: '100%' }} />
}

export default function EditorPane({
  onToggleFull,
  isFull
}: {
  onToggleFull?: () => void
  isFull?: boolean
}): JSX.Element {
  const file = useStore((s) => s.selectedFile)
  const selectFile = useStore((s) => s.selectFile)
  const pushToast = useStore((s) => s.pushToast)
  // Папка, относительно которой строим путь файла для git.diffFile (RFC 0011).
  // RFC 0013 Фаза 0: для фокус-сессии-клона — её рабочая копия (своя ветка), иначе
  // папка воркспейса. Должна совпадать с папкой FileTree (WorkspaceArea.filesFolder),
  // иначе rel-путь файла посчитается не от того корня.
  const wsFolder = useStore((s) =>
    diffSourceFolder(
      s.workspaces.find((w) => w.id === s.activeWorkspaceId),
      s.sessions,
      s.focusedSessionId
    )
  )
  // сигнал «список изменений обновился» (новая ссылка на каждый рефреш) — чтобы
  // живьём перечитывать diff, когда файл правят (руками в редакторе или агентом).
  const changedSig = useStore((s) => s.changedFiles[s.activeWorkspaceId ?? ''])
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [mode, setMode] = useState<'code' | 'preview' | 'browser' | 'diff'>('code')
  // пара текстов diff «было → стало» (RFC 0011)
  const [diffPair, setDiffPair] = useState<{ oldText: string; newText: string } | null>(null)
  // адресная строка браузера. Внешний сайт → src напрямую; локальный файл — через
  // локальный веб-сервер (так грузятся и соседние файлы: css, js, картинки).
  const [browserInput, setBrowserInput] = useState('')
  const [browserSrc, setBrowserSrc] = useState('')
  const [browserDoc, setBrowserDoc] = useState('') // готовый html локального файла (для srcDoc)
  const contentRef = useRef(content)
  contentRef.current = content
  const fileRef = useRef(file)
  fileRef.current = file

  const isMd = file?.name.toLowerCase().endsWith('.md') ?? false
  const isHtml =
    (file?.name.toLowerCase().endsWith('.html') || file?.name.toLowerCase().endsWith('.htm')) ?? false

  const navigate = async (raw: string): Promise<void> => {
    setBrowserInput(raw)
    const v = raw.trim()
    if (!v) {
      setBrowserSrc('')
      setBrowserDoc('')
      return
    }
    if (/^https?:\/\//.test(v)) {
      setBrowserDoc('')
      setBrowserSrc(v)
      return
    }
    if (v.startsWith('/')) {
      // локальный файл → свой протокол deck-preview:// с НАСТОЯЩИМИ слэшами в пути,
      // чтобы соседние css/js/jsx прототипа резолвились (asset:// ломал их на %2F).
      setBrowserDoc('')
      setBrowserSrc('deck-preview://localhost' + encodeURI(v))
      return
    }
    setBrowserDoc('')
    setBrowserSrc('https://' + v) // голый домен → https
  }

  // Переход в режим Браузер: html-файл сразу открываем, иначе оставляем что было.
  const openBrowser = (): void => {
    setMode('browser')
    if (!browserSrc && !browserDoc && file && isHtml) navigate(file.path)
  }

  const closeFile = (): void => {
    selectFile(undefined)
    setMode('code')
    setBrowserSrc('')
    setBrowserDoc('')
    setBrowserInput('')
  }

  // RFC 0011: перечитать пару «было → стало» с диска (актуальное «стало»). Зовём при
  // открытии, переключении на вкладку Diff, после сохранения и при правках файла —
  // иначе diff застывает на состоянии момента открытия и не показывает свежие правки.
  const loadDiff = useCallback(async (): Promise<void> => {
    const f = fileRef.current
    if (!f || !wsFolder) return
    const rel = f.path.startsWith(wsFolder + '/') ? f.path.slice(wsFolder.length + 1) : f.path
    try {
      const pair = await window.api.git.diffFile(wsFolder, rel)
      setDiffPair({ oldText: pair.oldText, newText: pair.newText })
    } catch {
      setDiffPair({ oldText: '', newText: '' })
    }
  }, [wsFolder])

  useEffect(() => {
    if (file) {
      // RFC 0011: открыт как diff (клик по файлу в списке «Изменения») → грузим
      // пару «было → стало» через git.diffFile и показываем Monaco DiffEditor.
      if (file.diff && wsFolder) {
        setMode('diff')
        setDirty(false)
        // сбрасываем прошлую пару → DiffEditor не остаётся на содержимом прежнего файла
        // (показываем «Загрузка diff…»), затем монтируется свежим с правильным «было/стало».
        setDiffPair(null)
        loadDiff()
        return
      }
      setDiffPair(null)
      window.api.fs.readFile(file.path).then((c) => {
        setContent(c)
        setDirty(false)
      })
      // md → превью, html → сразу в Браузер (видно отрисовку), остальное → редактор
      const lower = file.name.toLowerCase()
      if (lower.endsWith('.md')) setMode('preview')
      else if (lower.endsWith('.html') || lower.endsWith('.htm')) {
        setMode('browser')
        navigate(file.path)
      } else setMode('code')
    } else {
      setContent('')
      setDiffPair(null)
      setDirty(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.path, file?.diff])

  // Живое обновление: список изменений обновился (правка на диске) → пока открыт Diff,
  // перечитываем пару, чтобы свежие правки сразу были видны.
  useEffect(() => {
    if (mode === 'diff' && fileRef.current?.diff) loadDiff()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changedSig])

  const save = async (): Promise<void> => {
    const f = fileRef.current
    if (!f) return
    const ok = await window.api.fs.writeFile(f.path, contentRef.current)
    if (ok) {
      setDirty(false)
      pushToast('info', `Сохранено: ${f.name}`)
      loadDiff() // обновим пару «было→стало», чтобы Diff показал свежесохранённое
    }
  }

  // Превью markdown: рисуем marked, затем картинки с локальным путём подменяем на data-URL
  // (вебвью не грузит файлы по обычному пути — встраиваем байтами).
  const [previewHtml, setPreviewHtml] = useState('')
  useEffect(() => {
    if (!isMd || mode !== 'preview' || !file) {
      setPreviewHtml('')
      return
    }
    let cancelled = false
    ;(async () => {
      let raw: string
      try {
        raw = marked.parse(content, { async: false }) as string
      } catch {
        if (!cancelled) setPreviewHtml('<p>не удалось отрисовать markdown</p>')
        return
      }
      const doc = new DOMParser().parseFromString(raw, 'text/html')
      const baseDir = dirOf(file.path)
      await Promise.all(
        Array.from(doc.querySelectorAll('img')).map(async (img) => {
          const s = img.getAttribute('src') || ''
          if (!s || /^(https?:|data:)/.test(s)) return
          const abs = s.startsWith('/') ? s : resolvePath(baseDir, s)
          try {
            const url = await window.api.fs.readFileDataUrl(abs)
            if (url) img.setAttribute('src', url)
          } catch {
            /* картинку не прочитали — оставляем как есть */
          }
        })
      )
      if (!cancelled) setPreviewHtml(doc.body.innerHTML)
    })()
    return () => {
      cancelled = true
    }
  }, [content, isMd, mode, file?.path])

  return (
    <div className="editor-wrap">
      {/* Плавающая панель сверху по центру — всегда на месте (можно уйти в Браузер без файла). */}
      <div className="editor-island">
        <div className="mode-toggle">
          {file && (
            <button
              className={mode === 'code' ? 'on' : ''}
              onClick={() => {
                // из diff-режима контент мог быть не загружен — подтянем перед показом редактора
                if (mode === 'diff' && file) {
                  window.api.fs.readFile(file.path).then((c) => {
                    setContent(c)
                    setDirty(false)
                  })
                }
                setMode('code')
              }}
            >
              Редактор
            </button>
          )}
          {/* RFC 0011: кнопка Diff видна, когда файл открыт как изменённый (есть пара было→стало) */}
          {file && diffPair && (
            <button
              className={mode === 'diff' ? 'on' : ''}
              onClick={() => {
                setMode('diff')
                loadDiff() // перечитываем актуальное «стало» при каждом заходе в Diff
              }}
            >
              Diff
            </button>
          )}
          {isMd && (
            <button className={mode === 'preview' ? 'on' : ''} onClick={() => setMode('preview')}>
              Превью
            </button>
          )}
          <button className={mode === 'browser' ? 'on' : ''} onClick={openBrowser}>
            Браузер
          </button>
        </div>
        {dirty && file && mode === 'code' && (
          <button className="save-btn sm" onClick={save} title="⌘S">
            Сохранить
          </button>
        )}
        {onToggleFull && (
          <button
            className="editor-icon-btn"
            onClick={onToggleFull}
            title={isFull ? 'Свернуть' : 'На весь экран'}
          >
            {isFull ? <CollapseIcon /> : <ExpandIcon />}
          </button>
        )}
        {(file || mode === 'browser') && (
          <button className="editor-icon-btn" onClick={closeFile} title="Закрыть">
            ✕
          </button>
        )}
      </div>

      {mode === 'browser' ? (
        <div className="browser-pane">
          <form
            className="browser-bar"
            onSubmit={(e) => {
              e.preventDefault()
              navigate(browserInput)
            }}
          >
            <input
              value={browserInput}
              placeholder="адрес сайта (example.com) или путь к .html"
              onChange={(e) => setBrowserInput(e.target.value)}
            />
            <button type="submit" className="ws-tb-btn">
              Перейти
            </button>
            {(browserSrc || browserDoc) && (
              <button
                type="button"
                className="editor-icon-btn"
                title="Обновить"
                onClick={() => navigate(browserInput)}
              >
                ⟳
              </button>
            )}
          </form>
          {browserDoc ? (
            <iframe className="browser-frame" srcDoc={browserDoc} title="Браузер" />
          ) : browserSrc ? (
            <iframe className="browser-frame" src={browserSrc} title="Браузер" />
          ) : (
            <div className="editor-empty">Введи адрес сайта или открой .html-файл</div>
          )}
        </div>
      ) : !file ? (
        <div className="editor-empty">Выберите файл в дереве слева</div>
      ) : mode === 'diff' ? (
        // RFC 0011: diff единым (unified) видом — одна колонка. НЕ через
        // @monaco-editor/react <DiffEditor> (он монтирует пустые модели и обновляет их
        // через setValue → в monaco 0.52 diff после setValue НЕ пересчитывается, залипал
        // на «было»==«стало»). Свой InlineDiff на чистом monaco: модели создаются СРАЗУ
        // с текстом + setModel — надёжный путь (проверен в headless). key по содержимому →
        // свежий mount при реальной правке. Монтируем только когда пара загружена.
        !diffPair ? (
          <div className="editor-empty">Загрузка diff…</div>
        ) : (
          <InlineDiff
            key={`${file.path}:${hashText(diffPair.oldText)}:${hashText(diffPair.newText)}`}
            original={diffPair.oldText}
            modified={diffPair.newText}
            language={langOf(file.name)}
          />
        )
      ) : isMd && mode === 'preview' ? (
        <div className="md-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
      ) : (
        <Editor
          height="100%"
          theme="vs-dark"
          path={file.path}
          language={langOf(file.name)}
          value={content}
          onChange={(v) => {
            setContent(v ?? '')
            setDirty(true)
          }}
          onMount={(editor) => {
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save())
          }}
          options={{
            fontSize: 12.5,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            lineNumbers: 'on',
            renderWhitespace: 'none',
            wordWrap: 'on',
            automaticLayout: true,
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            overviewRulerBorder: false,
            lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off }, // без значка-лампы
            scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9, useShadows: false }
          }}
        />
      )}
    </div>
  )
}
