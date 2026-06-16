import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { statusColor } from './ChangesList'

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

  // авто-обновление: если папка раскрыта — перечитываем её содержимое на каждый тик
  // (так появляются новые файлы и пропадают удалённые, раскрытость не теряется)
  useEffect(() => {
    if (open && entry.isDir) window.api.fs.readDir(entry.path).then(setChildren)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

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
        {myStatus && (
          <span className="ft-git-dot" style={{ background: statusColor(myStatus) }} />
        )}
      </div>
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

  // карта «абсолютный путь → git-статус»: пути из git status относительны корня
  // репо (= folder), приводим к абсолютным для сравнения с узлами дерева.
  const gitStatusMap = useMemo(() => {
    const m = new Map<string, string>()
    const base = folder.replace(/\/$/, '')
    for (const f of changed ?? []) m.set(`${base}/${f.path}`, f.status)
    return m
  }, [changed, folder])

  const refresh = (): void => setTick((k) => k + 1)

  // перечитываем корень при смене папки и на каждый тик обновления
  useEffect(() => {
    window.api.fs.readDir(folder).then(setRoot)
  }, [folder, tick])

  // Путь A — живой наблюдатель ядра за этой папкой; Путь B — обновление при возврате окна в фокус.
  useEffect(() => {
    window.api.fs.watch(folder)
    const offChanged = window.api.on.fsChanged((changed) => {
      if (changed === folder) refresh()
    })
    const onFocus = (): void => refresh()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      offChanged()
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
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
        if (r.ok) refresh()
        else pushToast('error', r.error ?? 'Не удалось дублировать')
        break
      }
      case 'trash': {
        if (!confirm(`Удалить «${entry.name}» в Корзину?`)) break
        const r = await window.api.fs.trash(entry.path)
        if (r.ok) refresh()
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
    if (r.ok) refresh()
    else pushToast('error', r.error ?? 'Не удалось переименовать')
    setRenaming(null)
  }

  return (
    <RefreshCtx.Provider value={tick}>
    <GitStatusCtx.Provider value={gitStatusMap}>
    <div className="filetree" onClick={() => menu && setMenu(null)}>
      {root.map((e) => (
        <TreeNode key={e.path} entry={e} depth={0} onMenu={onMenu} />
      ))}

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
    </GitStatusCtx.Provider>
    </RefreshCtx.Provider>
  )
}
