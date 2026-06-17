import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useStore, useConflictInfo } from '../store'
import { statusColor } from './ChangesList'
import './FileTree.css'

interface Entry {
  name: string
  path: string
  isDir: boolean
}

// Тик обновления дерева. Когда он растёт — корень и КАЖДАЯ раскрытая папка
// перечитывают своё содержимое, сохраняя раскрытость (узлы не пересоздаются).
const RefreshCtx = createContext(0)

// RFC 0011: карта «абсолютный путь файла → git-статус» для пометки в дереве.
const GitStatusCtx = createContext<Map<string, string>>(new Map())

// X2 (RFC 0017): «контекст видимости» дерева при включённом фильтре «только изменённые».
//  • showOnlyChanged — включён ли фильтр (если нет — показываем всё, фильтрация выключена);
//  • changedSet — абсолютные пути ИЗМЕНЁННЫХ файлов (их показываем целиком);
//  • keepDirs — абсолютные пути папок-предков изменённых файлов (их оставляем видимыми,
//    чтобы до изменённого файла можно было дойти по дереву).
interface VisibilityCtx {
  showOnlyChanged: boolean
  changedSet: Set<string>
  keepDirs: Set<string>
}
const VisibilityContext = createContext<VisibilityCtx>({
  showOnlyChanged: false,
  changedSet: new Set(),
  keepDirs: new Set()
})

// X2 (RFC 0017): набор АБСОЛЮТНЫХ путей файлов-конфликтов (правят ≥2 дерева).
//  Считаем один раз на уровне FileTree (общий селектор useConflictInfo), узлам отдаём
//  готовый Set — узлу остаётся проверить entry.path.
const ConflictPathsCtx = createContext<Set<string>>(new Set())

// X2: буквенный значок git-статуса для дерева. modified/untracked → «M», added → «+»,
// deleted/renamed → «−». Цвет — общий statusColor (тот же, что у точки и в Ревью).
function statusGlyph(status: string): string {
  switch (status) {
    case 'added':
      return '+'
    case 'deleted':
    case 'renamed':
      return '−'
    default:
      return 'M'
  }
}

// Минималистичные иконки заливкой (не контур). Цвет — по типу, приглушённый.
function FolderIcon({ open }: { open: boolean }): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" className="ft-svg ft-svg-dir">
      {open ? (
        <path
          fill="currentColor"
          d="M1.5 4.2A1.2 1.2 0 0 1 2.7 3h3l1.3 1.3h5.3A1.2 1.2 0 0 1 13.5 5.5v.5H4.3a1 1 0 0 0-.96.73L1.7 12.5A1 1 0 0 1 1.5 12z M3.1 7.3a.7.7 0 0 1 .67-.5H15a.5.5 0 0 1 .48.64l-1.4 4.9a1 1 0 0 1-.96.66H2.1a.5.5 0 0 1-.48-.64z"
        />
      ) : (
        <path
          fill="currentColor"
          d="M1.5 4.2A1.2 1.2 0 0 1 2.7 3h3l1.3 1.3h5.3A1.2 1.2 0 0 1 13.5 5.5v6.3A1.2 1.2 0 0 1 12.3 13H2.7a1.2 1.2 0 0 1-1.2-1.2z"
        />
      )}
    </svg>
  )
}

function FileIcon({ name }: { name: string }): JSX.Element {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  let cls = 'ft-svg-file'
  if (['md', 'txt', 'rst'].includes(ext)) cls = 'ft-svg-doc'
  else if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'icns'].includes(ext)) cls = 'ft-svg-img'
  else if (['json', 'toml', 'yml', 'yaml', 'lock', 'env'].includes(ext)) cls = 'ft-svg-cfg'
  else if (['ts', 'tsx', 'js', 'jsx', 'rs', 'py', 'go', 'css', 'html', 'sh'].includes(ext)) cls = 'ft-svg-code'
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" className={`ft-svg ${cls}`}>
      <path fill="currentColor" d="M3.5 2h5.1L13 6.1V13a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" opacity="0.55" />
      <path fill="currentColor" d="M8.4 2.2 13 6.4H9.2a.8.8 0 0 1-.8-.8z" />
    </svg>
  )
}

interface MenuState {
  x: number
  y: number
  entry: Entry
}

function TreeNode({
  entry,
  depth,
  onMenu
}: {
  entry: Entry
  depth: number
  onMenu: (e: React.MouseEvent, entry: Entry) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<Entry[] | null>(null)
  const selectFile = useStore((s) => s.selectFile)
  const selectedPath = useStore((s) => s.selectedFile?.path)
  const tick = useContext(RefreshCtx)
  // RFC 0011: git-статус этого файла (для цвета имени), если он тронут агентом
  const gitStatus = useContext(GitStatusCtx)
  const myStatus = entry.isDir ? undefined : gitStatus.get(entry.path)
  // X2: этот файл правят ≥2 дерева одновременно → маркер конфликта ⚠ (только для файлов).
  const conflictPaths = useContext(ConflictPathsCtx)
  const isConflict = !entry.isDir && conflictPaths.has(entry.path)
  // X2: фильтр «только изменённые». Узел оставляем видимым, если фильтр выключен;
  //  иначе — для файла нужен git-статус, для папки — наличие изменённого потомка
  //  (она в keepDirs). Так до изменённого файла можно дойти, остальное скрыто.
  const vis = useContext(VisibilityContext)
  const visible = !vis.showOnlyChanged
    ? true
    : entry.isDir
      ? vis.keepDirs.has(entry.path)
      : vis.changedSet.has(entry.path)

  // авто-обновление: если папка раскрыта — перечитываем её содержимое на каждый тик
  // (так появляются новые файлы и пропадают удалённые, раскрытость не теряется).
  // Тик уже дебаунсится на уровне FileTree (всплеск fs:changed → один тик).
  // In-flight guard: если перечитывание ещё идёт, а тик уже сменился, не запускаем
  // параллельный readDir на ту же папку — иначе ответы могут прийти не по порядку.
  const childInFlight = useRef(false)
  useEffect(() => {
    if (!(open && entry.isDir) || childInFlight.current) return
    let cancelled = false
    childInFlight.current = true
    window.api.fs
      .readDir(entry.path)
      .then((entries) => {
        if (!cancelled) setChildren(entries)
      })
      .finally(() => {
        childInFlight.current = false
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  // X2: при включённом фильтре «только изменённые» папки-предки изменённых файлов
  //  авто-раскрываем — чтобы изменённые файлы сразу было видно, без ручного клика.
  //  Подгружаем содержимое лениво (как при обычном раскрытии). Эффект срабатывает
  //  только в режиме фильтра для keep-папок и не мешает ручному open/close вне фильтра.
  useEffect(() => {
    if (!(vis.showOnlyChanged && entry.isDir && vis.keepDirs.has(entry.path))) return
    if (!open) setOpen(true)
    if (!children) {
      let cancelled = false
      window.api.fs.readDir(entry.path).then((entries) => {
        if (!cancelled) setChildren(entries)
      })
      return () => {
        cancelled = true
      }
    }
    return
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vis.showOnlyChanged, vis.keepDirs])

  const toggle = async (): Promise<void> => {
    if (entry.isDir) {
      if (!open && !children) setChildren(await window.api.fs.readDir(entry.path))
      setOpen(!open)
    } else {
      // RFC 0011: изменённый файл (есть git-статус) открываем сразу с diff —
      // появляется вкладка Diff с видом «было → стало». Нетронутый — обычный редактор.
      selectFile({ path: entry.path, name: entry.name, diff: !!myStatus })
    }
  }

  // X2: в режиме фильтра скрытый узел просто не рендерим (потомков тоже — ниже по дереву).
  if (!visible) return <></>

  return (
    <div>
      <div
        className={`ft-row ${selectedPath === entry.path ? 'sel' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={toggle}
        onContextMenu={(e) => onMenu(e, entry)}
      >
        <span className="ft-caret">{entry.isDir ? (open ? '▾' : '▸') : ''}</span>
        <span className="ft-ico">
          {entry.isDir ? <FolderIcon open={open} /> : <FileIcon name={entry.name} />}
        </span>
        {/* RFC 0011: имя тронутого файла красим по git-статусу */}
        <span className="ft-name" style={myStatus ? { color: statusColor(myStatus) } : undefined}>
          {entry.name}
        </span>
        {/* X2 (RFC 0017): буквенный значок git-статуса (M / + / −) вместо точки —
            цвет тот же (statusColor), но статус читается с одного взгляда. */}
        {myStatus && (
          <span className="ft-badge" style={{ color: statusColor(myStatus) }} title={myStatus}>
            {statusGlyph(myStatus)}
          </span>
        )}
        {/* X2: маркер конфликта — этот файл правят ≥2 дерева одновременно. */}
        {isConflict && (
          <span className="ft-conflict" title="Этот файл правят несколько деревьев">
            ⚠
          </span>
        )}
      </div>
      {/* key = c.path: путь — естественная стабильная идентичность узла ФС.
          Trade-off (M9): при переименовании path меняется → React видит это как
          удаление старого + создание нового узла, и теряет локальное состояние
          (раскрытость/кэш children) переименованного узла. Это осознанный
          компромисс: синтетического неизменного id у записей readDir нет
          (только name/path/isDir), а городить inode-трекинг — оверинжиниринг
          ради редкого кейса. Внутри одной папки пути уникальны → коллизий ключей нет. */}
      {open &&
        children?.map((c) => <TreeNode key={c.path} entry={c} depth={depth + 1} onMenu={onMenu} />)}
    </div>
  )
}

export default function FileTree({ folder }: { folder: string }): JSX.Element {
  const [root, setRoot] = useState<Entry[]>([])
  const [tick, setTick] = useState(0) // рост тика = перечитать дерево (после операций и авто-изменений)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<Entry | null>(null)
  const [newName, setNewName] = useState('')
  const pushToast = useStore((s) => s.pushToast)
  const selectFile = useStore((s) => s.selectFile)
  // RFC 0011: тронутые файлы активного воркспейса (для пометки в дереве)
  const activeWsId = useStore((s) => s.activeWorkspaceId)
  const changed = useStore((s) => (activeWsId ? s.changedFiles[activeWsId] : undefined))
  // X2 (RFC 0017): фильтр «только изменённые» (runtime-флаг в сторе).
  const onlyChanged = useStore((s) => s.fileTreeShowOnlyChanged)
  const toggleOnlyChanged = useStore((s) => s.toggleFileTreeShowOnlyChanged)
  // X2: общий селектор конфликтов (та же логика, что в Ревью). Узкая подписка —
  //  компонент перерисуется лишь при смене состава/изменений/фокуса (см. store).
  const { conflictKeys } = useConflictInfo()
  // X2: чтобы построить ключ конфликта той же формы, что в сторе (base + '::' + relpath),
  //  нужна база ТОГО дерева, что показывает FileTree. База = cloneOf фокус-сессии-клона
  //  (если она в фокусе этого воркспейса) — иначе папка воркспейса. Это зеркало развилки
  //  diffSourceFolder/useConflictInfo: folder-проп = cwd клона, но ключ строится на cloneOf.
  const conflictBase = useStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
    if (!ws) return folder.replace(/\/$/, '')
    const focused = s.sessions.find((x) => x.id === s.focusedSessionId)
    const focusIsClone =
      !!focused &&
      focused.workspaceId === ws.id &&
      !!focused.cloneOf &&
      !!focused.cwd &&
      focused.cwd !== ws.folder
    return (focusIsClone ? (focused!.cloneOf ?? focused!.cwd) : ws.folder).replace(/\/$/, '')
  })

  // карта «абсолютный путь → git-статус»: пути из git status относительны корня
  // репо (= folder), приводим к абсолютным для сравнения с узлами дерева.
  const gitStatusMap = useMemo(() => {
    const m = new Map<string, string>()
    const base = folder.replace(/\/$/, '')
    for (const f of changed ?? []) m.set(`${base}/${f.path}`, f.status)
    return m
  }, [changed, folder])

  // X2: набор АБСОЛЮТНЫХ путей файлов-конфликтов в этом дереве. Ключ конфликта в сторе =
  //  conflictBase + '::' + relpath; абсолютный путь узла = folder + '/' + relpath. Сводим
  //  по общему relpath: для каждого изменённого файла строим оба и проверяем conflictKeys.
  const conflictPaths = useMemo(() => {
    const set = new Set<string>()
    const fileBase = folder.replace(/\/$/, '')
    for (const f of changed ?? []) {
      if (conflictKeys.has(`${conflictBase}::${f.path}`)) set.add(`${fileBase}/${f.path}`)
    }
    return set
  }, [changed, folder, conflictBase, conflictKeys])

  // X2: множества для фильтра «только изменённые». changedSet — абсолютные пути изменённых
  //  файлов; keepDirs — все папки-предки этих файлов (их оставляем видимыми, чтобы дойти
  //  до файла). Считаем из тех же changed-данных, что и gitStatusMap.
  const { changedSet, keepDirs } = useMemo(() => {
    const files = new Set<string>()
    const dirs = new Set<string>()
    const base = folder.replace(/\/$/, '')
    for (const f of changed ?? []) {
      const abs = `${base}/${f.path}`
      files.add(abs)
      // все промежуточные папки от корня (base) до файла — в keepDirs
      const parts = f.path.split('/')
      let cur = base
      for (let i = 0; i < parts.length - 1; i++) {
        cur = `${cur}/${parts[i]}`
        dirs.add(cur)
      }
    }
    return { changedSet: files, keepDirs: dirs }
  }, [changed, folder])

  // Дебаунс авто-обновления: множество событий fs:changed подряд (агент пишет
  // десятки файлов) схлопываются в один тик, чтобы не дёргать readDir на каждый
  // чих. perf-аудит M (FileTree.tsx:144-151).
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refresh = (): void => {
    // окно скрыто — не перечитываем зря, наверстаем по visibilitychange/focus
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null
      setTick((k) => k + 1)
    }, 250)
  }
  // Мгновенное обновление без дебаунса — после явных операций пользователя
  // (переименование/удаление/дублирование), где ждать 250 мс не нужно.
  const refreshNow = (): void => {
    if (refreshTimer.current) {
      clearTimeout(refreshTimer.current)
      refreshTimer.current = null
    }
    setTick((k) => k + 1)
  }

  // перечитываем корень при смене папки и на каждый тик обновления.
  // In-flight guard: если за время чтения прилетел новый тик — перечитываем
  // ещё раз ОДИН раз после завершения, чтобы не было параллельных readDir и
  // чтобы не потерять последнее состояние диска (perf-аудит).
  const rootInFlight = useRef(false)
  const rootRerunTick = useRef<number | null>(null)
  useEffect(() => {
    let cancelled = false
    const read = (t: number): void => {
      if (rootInFlight.current) {
        // чтение уже идёт — запомним самый свежий тик и догоним по завершении
        rootRerunTick.current = t
        return
      }
      rootInFlight.current = true
      rootRerunTick.current = null
      window.api.fs
        .readDir(folder)
        .then((entries) => {
          if (!cancelled) setRoot(entries)
        })
        .finally(() => {
          rootInFlight.current = false
          if (!cancelled && rootRerunTick.current !== null) read(rootRerunTick.current)
        })
    }
    read(tick)
    return () => {
      cancelled = true
    }
  }, [folder, tick])

  // Путь A — живой наблюдатель ядра за этой папкой; Путь B — обновление при возврате окна в фокус.
  //
  // Жизненный цикл слушателей (H13):
  //   • Эффект зависит от [folder]. При смене папки React сначала вызовет cleanup
  //     (снимет старый слушатель fs:changed и оконные обработчики), затем заведёт
  //     новый — то есть на каждую папку ровно один комплект слушателей.
  //   • При размонтировании компонента cleanup тоже отрабатывает → утечки нет,
  //     даже если папка не менялась (защита от дублей при remount, в т.ч. от
  //     двойного монтирования React 18 StrictMode в dev).
  //   • Дебаунс-таймер тоже гасим в cleanup, чтобы отложенный setTick не выстрелил
  //     в уже размонтированном/перемонтированном дереве.
  useEffect(() => {
    window.api.fs.watch(folder)
    const offChanged = window.api.on.fsChanged((changed) => {
      // авто-обновление дебаунсится: всплеск событий схлопывается в один тик
      if (changed === folder) refresh()
    })
    // Возврат окна в фокус/видимость — мгновенное наверстывание (дебаунс пропускает
    // обновления, пока окно скрыто; здесь догоняем сразу одним перечитыванием).
    const onVisible = (): void => {
      if (document.visibilityState !== 'hidden') refreshNow()
    }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      offChanged()
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current)
        refreshTimer.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder])

  const onMenu = (e: React.MouseEvent, entry: Entry): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, entry })
  }

  const act = async (action: string): Promise<void> => {
    if (!menu) return
    const { entry } = menu
    setMenu(null)
    switch (action) {
      case 'open':
        if (!entry.isDir)
          selectFile({ path: entry.path, name: entry.name, diff: gitStatusMap.has(entry.path) })
        break
      case 'reveal':
        await window.api.fs.reveal(entry.path)
        break
      case 'copyPath':
        await window.api.clipboard.write(entry.path)
        pushToast('info', 'Путь скопирован')
        break
      case 'rename':
        setRenaming(entry)
        setNewName(entry.name)
        break
      case 'duplicate': {
        const r = await window.api.fs.duplicate(entry.path)
        if (r.ok) refreshNow()
        else pushToast('error', r.error ?? 'Не удалось дублировать')
        break
      }
      case 'trash': {
        if (!confirm(`Удалить «${entry.name}» в Корзину?`)) break
        const r = await window.api.fs.trash(entry.path)
        if (r.ok) refreshNow()
        else pushToast('error', r.error ?? 'Не удалось удалить')
        break
      }
    }
  }

  const doRename = async (): Promise<void> => {
    if (!renaming) return
    const name = newName.trim()
    if (!name || name === renaming.name) {
      setRenaming(null)
      return
    }
    const r = await window.api.fs.rename(renaming.path, name)
    if (r.ok) refreshNow()
    else pushToast('error', r.error ?? 'Не удалось переименовать')
    setRenaming(null)
  }

  const hasChanged = (changed?.length ?? 0) > 0

  return (
    <RefreshCtx.Provider value={tick}>
    <GitStatusCtx.Provider value={gitStatusMap}>
    <ConflictPathsCtx.Provider value={conflictPaths}>
    <VisibilityContext.Provider value={{ showOnlyChanged: onlyChanged, changedSet, keepDirs }}>
    <div className="filetree" onClick={() => menu && setMenu(null)}>
      {/* X2 (RFC 0017): переключатель «только изменённые» — показывает в дереве лишь
          изменённые файлы (и папки-предки до них). */}
      <div className="ft-header">
        <button
          className={`ft-filter-toggle ${onlyChanged ? 'on' : ''}`}
          title="Показывать в дереве только изменённые файлы"
          onClick={(e) => {
            e.stopPropagation()
            toggleOnlyChanged()
          }}
        >
          <span className="ft-filter-dot" />
          только изменённые
        </button>
      </div>

      {/* key = e.path: см. комментарий о trade-off переименования в TreeNode (M9). */}
      {root.map((e) => (
        <TreeNode key={e.path} entry={e} depth={0} onMenu={onMenu} />
      ))}

      {/* X2: фильтр включён, но изменённых файлов нет — явная заглушка вместо пустоты. */}
      {onlyChanged && !hasChanged && (
        <div className="ft-empty-changed">Нет изменённых файлов</div>
      )}

      {menu && (
        <>
          <div className="ctx-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }} />
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
            {!menu.entry.isDir && <button onClick={() => act('open')}>Открыть</button>}
            <button onClick={() => act('rename')}>Переименовать</button>
            <button onClick={() => act('duplicate')}>Дублировать</button>
            <div className="ctx-sep" />
            <button onClick={() => act('copyPath')}>Копировать путь</button>
            <button onClick={() => act('reveal')}>Показать в Finder</button>
            <div className="ctx-sep" />
            <button className="danger" onClick={() => act('trash')}>
              Удалить
            </button>
          </div>
        </>
      )}

      {renaming && (
        <div className="modal-backdrop" onClick={() => setRenaming(null)}>
          <div className="modal slim" onClick={(e) => e.stopPropagation()}>
            <h3>Переименовать</h3>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') doRename()
                if (e.key === 'Escape') setRenaming(null)
              }}
            />
            <div className="af-actions">
              <button className="btn-ghost" onClick={() => setRenaming(null)}>
                Отмена
              </button>
              <button className="btn-primary" onClick={doRename}>
                ОК
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </VisibilityContext.Provider>
    </ConflictPathsCtx.Provider>
    </GitStatusCtx.Provider>
    </RefreshCtx.Provider>
  )
}
