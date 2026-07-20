import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ClipboardPaste,
  Copy,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import type { ImageEntry } from '@/lib/fs-provider'
import type { FileOpResult } from '@/lib/fs-provider'
import { getFSProvider } from '@/lib/fs-provider'
import type { DirNode } from '@/lib/dir-tree'
import { isAbsPath, normalizeSlashes, scopeOk } from '@/lib/dir-tree'
import { formatBytes, formatTime } from '@/lib/format'
import { getVisibleImages, useAppStore } from '@/store/appStore'
import type { SortKey } from '@/store/appStore'
import {
  pasteFiles,
  makeDirectory,
  trashEntries,
  writeSupported,
  writeUnsupportedReason,
  dropToDirectory,
  dropItemsFromDataTransfer,
  electronTargetDir,
} from '@/lib/file-ops'
import { ConfirmDialog, ContextMenu, NameDialog } from '@/components/FileOpsMenu'
import type { MenuItem } from '@/components/FileOpsMenu'
import { FolderFrame, FolderIcon } from '@/components/FolderIcon'
import { cn } from '@/lib/utils'

interface MenuState {
  x: number
  y: number
  target: ImageEntry | null
  folder: DirNode | null
}

/** 列表模式的像素尺寸缓存（img onLoad 读取 naturalWidth/Height，免额外解码） */
const dimsCache = new Map<string, { w: number; h: number }>()

/** 操作结果摘要（失败逐文件列出，最多 3 条） */
function opSummary(verb: string, r: FileOpResult): string {
  const parts: string[] = []
  if (r.ok.length > 0) parts.push(`已${verb} ${r.ok.length} 个`)
  if (r.failed.length > 0) {
    const detail = r.failed
      .slice(0, 3)
      .map((f) => `${f.name}（${f.error}）`)
      .join('；')
    parts.push(`失败 ${r.failed.length} 个：${detail}${r.failed.length > 3 ? '…' : ''}`)
  }
  return parts.join('，') || '没有可处理的文件'
}

/* ------------------------------ 面包屑 ------------------------------ */

interface Crumb {
  label: string
  path: string
}

/** 面包屑段：相对路径 = 根名 + 逐段；祖先链绝对路径 = 逐段绝对前缀 */
function BreadcrumbBar() {
  const dir = useAppStore((s) => s.dir)
  const currentPath = useAppStore((s) => s.currentPath)
  const setCurrentPath = useAppStore((s) => s.setCurrentPath)
  const navigateUp = useAppStore((s) => s.navigateUp)

  const crumbs = useMemo((): Crumb[] => {
    if (!dir) return []
    if (isAbsPath(currentPath)) {
      const parts = normalizeSlashes(currentPath).split('/').filter(Boolean)
      return parts.map((p, i) => ({ label: p, path: parts.slice(0, i + 1).join('/') }))
    }
    const rootName = dir.dirPath
      ? (dir.dirPath.split(/[\\/]/).filter(Boolean).pop() ?? dir.dirPath)
      : dir.name
    const list: Crumb[] = [{ label: rootName || '根目录', path: '' }]
    if (currentPath) {
      const parts = currentPath.split('/')
      parts.forEach((p, i) => list.push({ label: p, path: parts.slice(0, i + 1).join('/') }))
    }
    return list
  }, [dir, currentPath])

  if (!dir) return null

  return (
    <div className="flex shrink-0 select-none items-center gap-1.5 border-b border-[var(--tv-line)] bg-[var(--tv-panel2)] px-3 py-1.5 text-xs">
      <button
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--tv-text-dim)] hover:bg-[var(--tv-hover)] hover:text-[var(--tv-text)] disabled:cursor-not-allowed disabled:opacity-30"
        onClick={navigateUp}
        disabled={!currentPath}
        title="返回上级文件夹（Backspace）"
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </button>
      <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1
          return (
            <span key={`${i}:${c.path}`} className="flex shrink-0 items-center gap-0.5">
              {i > 0 && <ChevronRight className="h-3 w-3 text-[var(--tv-text-faint)]" />}
              <button
                className={cn(
                  'max-w-48 truncate rounded px-1 py-0.5',
                  last ? 'font-medium text-sky-300' : 'text-[var(--tv-text-dim)] hover:bg-[var(--tv-hover)] hover:text-[var(--tv-text)]',
                )}
                onClick={() => {
                  if (!last) setCurrentPath(c.path)
                }}
                title={c.path || '根目录'}
              >
                {c.label}
              </button>
            </span>
          )
        })}
      </nav>
    </div>
  )
}

/* --------------------------- 文件夹条目 --------------------------- */

/** 文件夹卡片（图标档）：前 1–4 张图片 2×2 拼贴，无图片时纯图标；双击进入 */
const FolderCard = memo(function FolderCard({
  node,
  entries,
  size,
  selected,
  onSelect,
  onOpen,
  onContextMenu,
}: {
  node: DirNode
  entries: ImageEntry[]
  size: number
  selected: boolean
  onSelect: () => void
  onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const preview = useMemo(() => entries.slice(0, 4), [entries])
  const [urls, setUrls] = useState<string[]>([])

  useEffect(() => {
    setUrls([])
    const el = ref.current
    if (!el || preview.length === 0) return
    let cancelled = false
    const io = new IntersectionObserver(
      (ents) => {
        if (ents[0].isIntersecting) {
          io.disconnect()
          void Promise.all(preview.map((e) => e.getUrl())).then((us) => {
            if (!cancelled) setUrls(us)
          })
        }
      },
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => {
      cancelled = true
      io.disconnect()
    }
  }, [preview])

  return (
    <div
      ref={ref}
      data-folder
      className={cn(
        'group relative flex cursor-pointer flex-col overflow-hidden rounded border bg-[var(--tv-card)]',
        selected ? 'border-sky-500' : 'border-transparent hover:border-[var(--tv-border2)]',
      )}
      style={{ width: size }}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      title={`${node.relPath || node.name}（双击进入，右键菜单）`}
    >
      <div className="overflow-hidden bg-[var(--tv-well)]" style={{ width: size, height: size }}>
        {preview.length === 0 ? (
          <div className="flex h-full w-full items-center justify-center">
            <FolderIcon className="h-3/5 w-3/5" />
          </div>
        ) : (
          <div className="relative h-full w-full">
            {/* 拼贴预览嵌在文件夹主体区域（FolderFrame 主体约 x:9%..91%, y:36%..84%） */}
            <div className="absolute overflow-hidden rounded-sm" style={{ left: '9%', top: '36%', width: '82%', height: '48%' }}>
              <div className="grid h-full w-full grid-cols-2 grid-rows-2 gap-px bg-black/50">
                {preview.map((e, i) => (
                  <div
                    key={e.id}
                    className={cn(
                      'flex items-center justify-center overflow-hidden',
                      preview.length === 1 && 'col-span-2 row-span-2',
                    )}
                  >
                    {urls[i] ? (
                      <img src={urls[i]} alt={e.name} loading="lazy" className="h-full w-full object-cover" draggable={false} />
                    ) : (
                      <div className="text-xs text-[var(--tv-text-faint)]">…</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <FolderFrame className="pointer-events-none absolute inset-0 h-full w-full" />
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 px-1.5 py-1">
        <FolderIcon className="h-3.5 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--tv-text)]" title={node.name}>
          {node.name}
        </span>
        <span className="shrink-0 text-[10px] text-[var(--tv-text-faint)]" title="图片数（含子目录）">
          {entries.length} 项
        </span>
      </div>
    </div>
  )
})

/* --------------------------- 列表模式 --------------------------- */

/** 列表头：名称 / 大小 / 修改时间可点击排序（复用全局排序状态） */
function ListHeader() {
  const sortKey = useAppStore((s) => s.sortKey)
  const sortAsc = useAppStore((s) => s.sortAsc)
  const setSortKey = useAppStore((s) => s.setSortKey)
  const toggleSortAsc = useAppStore((s) => s.toggleSortAsc)

  const onSort = (k: SortKey) => {
    if (k === sortKey) toggleSortAsc()
    else setSortKey(k)
  }
  const head = (label: string, k: SortKey, className: string) => (
    <button
      className={cn('flex items-center gap-0.5 hover:text-[var(--tv-text)]', className)}
      onClick={() => onSort(k)}
      title={`按${label}排序（点击切换升降序）`}
    >
      {label}
      {sortKey === k &&
        (sortAsc ? <ChevronUp className="h-3 w-3 text-sky-400" /> : <ChevronDown className="h-3 w-3 text-sky-400" />)}
    </button>
  )

  return (
    <div className="flex select-none items-center gap-2 border-b border-[var(--tv-line)] px-2 py-1.5 text-[11px] text-[var(--tv-text-faint)]">
      <span className="w-4 shrink-0" />
      <span className="w-10 shrink-0" />
      {head('名称', 'name', 'min-w-0 flex-1 justify-start text-left')}
      <span className="w-24 shrink-0 text-right">像素尺寸</span>
      {head('大小', 'size', 'w-24 shrink-0 justify-end text-right')}
      {head('修改时间', 'lastModified', 'w-36 shrink-0 justify-end text-right')}
    </div>
  )
}

/** 列表模式：文件夹行（类型为「文件夹 · 计数」，无勾选框） */
const FolderRow = memo(function FolderRow({
  node,
  count,
  selected,
  onSelect,
  onOpen,
  onContextMenu,
}: {
  node: DirNode
  count: number
  selected: boolean
  onSelect: () => void
  onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  return (
    <div
      data-folder
      className={cn(
        'group flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1 text-xs',
        selected ? 'bg-sky-600/20' : 'hover:bg-[var(--tv-soft)]',
      )}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      title={`${node.relPath || node.name}（双击进入，右键菜单）`}
    >
      <span className="w-4 shrink-0" />
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-[var(--tv-well)]">
        <FolderIcon className="h-6 w-7" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[var(--tv-text)]">{node.name}</span>
      <span className="w-24 shrink-0 text-right text-[var(--tv-text-faint)]">—</span>
      <span className="w-24 shrink-0 text-right text-[var(--tv-text-dim)]" title="图片数（含子目录）">
        文件夹 · {count}
      </span>
      <span className="w-36 shrink-0 text-right text-[var(--tv-text-faint)]">—</span>
    </div>
  )
})

/** 列表模式：图片行（checkbox / 小缩略图 / 名称 / 像素尺寸 / 大小 / 修改时间） */
const ImageRow = memo(function ImageRow({
  entry,
  checked,
  isCurrent,
  onToggle,
  onOpen,
  onSelect,
  onContextMenu,
}: {
  entry: ImageEntry
  checked: boolean
  isCurrent: boolean
  onToggle: () => void
  onOpen: () => void
  onSelect: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(dimsCache.get(entry.id) ?? null)

  // 与胶片条联动：成为当前项时滚动到可视区
  useEffect(() => {
    if (isCurrent) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [isCurrent])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let cancelled = false
    const io = new IntersectionObserver(
      (ents) => {
        if (ents[0].isIntersecting) {
          io.disconnect()
          void entry.getUrl().then((u) => {
            if (!cancelled) setUrl(u)
          })
        }
      },
      { rootMargin: '100px' },
    )
    io.observe(el)
    return () => {
      cancelled = true
      io.disconnect()
    }
  }, [entry])

  return (
    <div
      ref={ref}
      data-thumb
      className={cn(
        'group flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1 text-xs',
        checked ? 'bg-sky-600/15' : 'hover:bg-[var(--tv-soft)]',
        isCurrent && 'ring-1 ring-amber-500',
      )}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      title={`${entry.path}（双击进入单图模式，右键文件操作）`}
    >
      <input
        type="checkbox"
        className="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
        checked={checked}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        title="勾选用于 A/B 对比与导航"
      />
      <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-[var(--tv-well)]">
        {url ? (
          <img
            src={url}
            alt={entry.name}
            loading="lazy"
            className="h-full w-full object-contain"
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget
              const d = { w: img.naturalWidth, h: img.naturalHeight }
              dimsCache.set(entry.id, d)
              setDims(d)
            }}
          />
        ) : (
          <span className="text-[10px] text-[var(--tv-text-faint)]">…</span>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[var(--tv-text)]">{entry.name}</span>
      <span className="w-24 shrink-0 text-right text-[var(--tv-text-dim)]">{dims ? `${dims.w} × ${dims.h}` : '—'}</span>
      <span className="w-24 shrink-0 text-right text-[var(--tv-text-dim)]">{formatBytes(entry.size)}</span>
      <span className="w-36 shrink-0 text-right text-[var(--tv-text-dim)]">{formatTime(entry.lastModified)}</span>
    </div>
  )
})

/* --------------------------- 缩略图（图标档） --------------------------- */

/** 单张缩略图：IntersectionObserver 懒加载 object URL */
const ThumbItem = memo(function ThumbItem({
  entry,
  size,
  checked,
  isCurrent,
  onToggle,
  onOpen,
  onSelect,
  onContextMenu,
}: {
  entry: ImageEntry
  size: number
  checked: boolean
  isCurrent: boolean
  onToggle: () => void
  onOpen: () => void
  onSelect: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [url, setUrl] = useState<string | null>(null)

  // 与胶片条联动：成为当前项时滚动到可视区
  useEffect(() => {
    if (isCurrent) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [isCurrent])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let cancelled = false
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          io.disconnect()
          void entry.getUrl().then((u) => {
            if (!cancelled) setUrl(u)
          })
        }
      },
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => {
      cancelled = true
      io.disconnect()
    }
  }, [entry])

  return (
    <div
      ref={ref}
      data-thumb
      className={cn(
        'group relative flex cursor-pointer flex-col overflow-hidden rounded border bg-[var(--tv-card)]',
        checked ? 'border-sky-500' : 'border-transparent hover:border-[var(--tv-border2)]',
        isCurrent && 'ring-1 ring-amber-500',
      )}
      style={{ width: size }}
      onDoubleClick={onOpen}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={`${entry.path}（双击进入单图模式，右键文件操作）`}
    >
      <div
        className="flex items-center justify-center overflow-hidden bg-[var(--tv-well)]"
        style={{ width: size, height: size }}
      >
        {url ? (
          <img src={url} alt={entry.name} loading="lazy" className="h-full w-full object-contain" draggable={false} />
        ) : (
          <div className="text-xs text-[var(--tv-text-faint)]">…</div>
        )}
      </div>
      <div className="truncate px-1.5 py-1 text-center text-[11px] text-[var(--tv-text)]">{entry.name}</div>
      {/* 勾选标记仅保留左上角 checkbox（选中态由边框高亮表达） */}
      <label
        className={cn(
          'absolute left-1 top-1 rounded bg-black/60 p-0.5',
          checked ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer accent-sky-500"
          checked={checked}
          onChange={onToggle}
          title="勾选用于 A/B 对比与导航"
        />
      </label>
    </div>
  )
})

/* ----------------------------- 主组件 ----------------------------- */

export function ThumbnailGrid() {
  const images = useAppStore((s) => s.images)
  const dir = useAppStore((s) => s.dir)
  const currentPath = useAppStore((s) => s.currentPath)
  const recursive = useAppStore((s) => s.recursive)
  const formatFilter = useAppStore((s) => s.formatFilter)
  const sortKey = useAppStore((s) => s.sortKey)
  const sortAsc = useAppStore((s) => s.sortAsc)
  const thumbSize = useAppStore((s) => s.thumbSize)
  const browseMode = useAppStore((s) => s.browseMode)
  const checked = useAppStore((s) => s.checked)
  const currentId = useAppStore((s) => s.currentId)
  const providerKind = useAppStore((s) => s.providerKind)
  const clipboard = useAppStore((s) => s.clipboard)
  const subdirs = useAppStore((s) => s.treeChildren[s.currentPath])
  const toggleChecked = useAppStore((s) => s.toggleChecked)
  const enterSingle = useAppStore((s) => s.enterSingle)
  const setCurrent = useAppStore((s) => s.setCurrent)
  const setClipboard = useAppStore((s) => s.setClipboard)
  const rescan = useAppStore((s) => s.rescan)
  const setCurrentPath = useAppStore((s) => s.setCurrentPath)
  const loadTreeChildren = useAppStore((s) => s.loadTreeChildren)

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [nameDialogOpen, setNameDialogOpen] = useState(false)
  const [deleteTargets, setDeleteTargets] = useState<ImageEntry[] | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null)

  const visible = useMemo(
    () => getVisibleImages({ images, dir, currentPath, recursive, formatFilter, sortKey, sortAsc }),
    [images, dir, currentPath, recursive, formatFilter, sortKey, sortAsc],
  )
  const checkedSet = useMemo(() => new Set(checked), [checked])

  // 当前目录的直接子文件夹（无论递归开关都显示，排在图片前；复用文件夹树的懒加载缓存）
  const folders = useMemo(() => subdirs ?? [], [subdirs])
  useEffect(() => {
    if (dir && subdirs === undefined) void loadTreeChildren(currentPath)
  }, [dir, currentPath, subdirs, loadTreeChildren])

  // 切换目录后清空文件夹选中态
  useEffect(() => {
    setSelectedFolder(null)
  }, [currentPath])

  // 各子文件夹的图片（递归视野，按名称排序）：拼贴预览与计数
  const folderEntries = useMemo(() => {
    const map = new Map<string, ImageEntry[]>()
    for (const f of folders) map.set(f.relPath, [])
    if (folders.length === 0 || !dir) return map
    for (const e of images) {
      for (const f of folders) {
        if (scopeOk(e, dir, f.relPath, true)) {
          map.get(f.relPath)!.push(e)
          break // 同层子文件夹互不重叠，命中即停
        }
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }))
    }
    return map
  }, [folders, images, dir])

  // 操作目标：右键项在勾选集合内 → 视野内全部勾选项；否则仅右键项
  const opTargets = useMemo((): ImageEntry[] => {
    if (!menu?.target) return []
    if (checkedSet.has(menu.target.id)) return visible.filter((e) => checkedSet.has(e.id))
    return [menu.target]
  }, [menu, visible, checkedSet])

  const clipboardEntries = useMemo(() => {
    const set = new Set(clipboard)
    return images.filter((e) => set.has(e.id))
  }, [clipboard, images])

  // toast 自动消失
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])

  if (!dir) return null

  const canWrite = writeSupported(dir)
  const noWriteReason = writeUnsupportedReason(dir)

  const runOp = async (fn: () => Promise<string>) => {
    setBusy(true)
    try {
      setToast(await fn())
    } catch (err) {
      setToast(`操作失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const doCopy = () => {
    setClipboard(opTargets.map((e) => e.id))
    setToast(`已复制 ${opTargets.length} 项（粘贴 = 复制到当前目录）`)
  }

  const doPaste = () =>
    runOp(async () => {
      const r = await pasteFiles(clipboardEntries, currentPath, dir)
      await rescan()
      return opSummary('粘贴', r)
    })

  const doMakeDir = (name: string) => {
    setNameDialogOpen(false)
    void runOp(async () => {
      const r = await makeDirectory(name, currentPath, dir)
      if (!r.ok) return `新建文件夹失败：${r.error}`
      await rescan()
      return `已新建文件夹「${name}」`
    })
  }

  const doDelete = () => {
    const targets = deleteTargets ?? []
    setDeleteTargets(null)
    void runOp(async () => {
      const r = await trashEntries(targets, dir)
      await rescan()
      return opSummary('删除', r)
    })
  }

  const menuItems: MenuItem[] = menu?.folder
    ? [
        {
          icon: <FolderOpen className="h-3.5 w-3.5" />,
          label: '打开',
          onClick: () => {
            if (menu.folder) setCurrentPath(menu.folder.relPath)
          },
        },
      ]
    : menu?.target
      ? [
          { icon: <Copy className="h-3.5 w-3.5" />, label: `复制 (${opTargets.length})`, onClick: doCopy },
          {
            icon: <ClipboardPaste className="h-3.5 w-3.5" />,
            label: `粘贴 (${clipboardEntries.length})`,
            disabled: !canWrite || clipboardEntries.length === 0,
            title: !canWrite ? (noWriteReason ?? undefined) : clipboardEntries.length === 0 ? '剪贴板为空' : undefined,
            onClick: () => void doPaste(),
          },
          {
            icon: <FolderPlus className="h-3.5 w-3.5" />,
            label: '新建文件夹',
            disabled: !canWrite,
            title: noWriteReason ?? undefined,
            onClick: () => setNameDialogOpen(true),
          },
          {
            icon: <Trash2 className="h-3.5 w-3.5" />,
            label: `删除 (${opTargets.length})`,
            danger: true,
            disabled: !canWrite,
            title: noWriteReason ?? undefined,
            onClick: () => setDeleteTargets(opTargets),
          },
        ]
      : [
          {
            icon: <ClipboardPaste className="h-3.5 w-3.5" />,
            label: `粘贴 (${clipboardEntries.length})`,
            disabled: !canWrite || clipboardEntries.length === 0,
            title: !canWrite ? (noWriteReason ?? undefined) : clipboardEntries.length === 0 ? '剪贴板为空' : undefined,
            onClick: () => void doPaste(),
          },
          {
            icon: <FolderPlus className="h-3.5 w-3.5" />,
            label: '新建文件夹',
            disabled: !canWrite,
            title: noWriteReason ?? undefined,
            onClick: () => setNameDialogOpen(true),
          },
          {
            icon: <RefreshCw className="h-3.5 w-3.5" />,
            label: '刷新',
            onClick: () => void rescan(),
          },
        ]

  const empty = visible.length === 0 && folders.length === 0

  return (
    <div className="flex h-full flex-col">
      <BreadcrumbBar />
      <div
        className="relative min-h-0 flex-1 overflow-y-auto p-3"
        onContextMenu={(e) => {
          e.preventDefault()
          const t = e.target as HTMLElement
          if (t.closest('[data-thumb]') || t.closest('[data-folder]')) return
          setMenu({ x: e.clientX, y: e.clientY, target: null, folder: null })
        }}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('[data-folder]')) setSelectedFolder(null)
        }}
      >
        {empty ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            {images.length === 0
              ? '当前文件夹没有图片'
              : '当前目录/过滤条件下没有内容（可切换目录或调整「含子文件夹」/ 格式过滤）'}
          </div>
        ) : browseMode === 'list' ? (
          <div>
            <ListHeader />
            {folders.map((f) => (
              <FolderRow
                key={f.relPath}
                node={f}
                count={folderEntries.get(f.relPath)?.length ?? 0}
                selected={selectedFolder === f.relPath}
                onSelect={() => setSelectedFolder(f.relPath)}
                onOpen={() => setCurrentPath(f.relPath)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setMenu({ x: e.clientX, y: e.clientY, target: null, folder: f })
                }}
              />
            ))}
            {visible.map((entry) => (
              <ImageRow
                key={entry.id}
                entry={entry}
                checked={checkedSet.has(entry.id)}
                isCurrent={entry.id === currentId}
                onToggle={() => toggleChecked(entry.id)}
                onOpen={() => enterSingle(entry.id)}
                onSelect={() => setCurrent(entry.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setMenu({ x: e.clientX, y: e.clientY, target: entry, folder: null })
                }}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {folders.map((f) => (
              <FolderCard
                key={f.relPath}
                node={f}
                entries={folderEntries.get(f.relPath) ?? []}
                size={thumbSize}
                selected={selectedFolder === f.relPath}
                onSelect={() => setSelectedFolder(f.relPath)}
                onOpen={() => setCurrentPath(f.relPath)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setMenu({ x: e.clientX, y: e.clientY, target: null, folder: f })
                }}
              />
            ))}
            {visible.map((entry) => (
              <ThumbItem
                key={entry.id}
                entry={entry}
                size={thumbSize}
                checked={checkedSet.has(entry.id)}
                isCurrent={entry.id === currentId}
                onToggle={() => toggleChecked(entry.id)}
                onOpen={() => enterSingle(entry.id)}
                onSelect={() => setCurrent(entry.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setMenu({ x: e.clientX, y: e.clientY, target: entry, folder: null })
                }}
              />
            ))}
          </div>
        )}

        {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

        {nameDialogOpen && (
          <NameDialog title="新建文件夹" onSubmit={doMakeDir} onClose={() => setNameDialogOpen(false)} />
        )}

        {deleteTargets && (
          <ConfirmDialog
            title={`删除 ${deleteTargets.length} 个文件`}
            danger
            confirmLabel="删除"
            body={
              <div className="space-y-1">
                {providerKind === 'electron' ? (
                  <p>将把以下 {deleteTargets.length} 个文件<strong>移入回收站</strong>：</p>
                ) : (
                  <p className="text-red-400">
                    将<strong>直接删除</strong>以下 {deleteTargets.length} 个文件：
                    <strong>不进回收站，此操作不可恢复！</strong>
                  </p>
                )}
                <ul className="mt-1 space-y-0.5 text-[var(--tv-text-dim)]">
                  {deleteTargets.slice(0, 8).map((e) => (
                    <li key={e.id} className="truncate" title={e.path}>
                      · {e.name}
                    </li>
                  ))}
                  {deleteTargets.length > 8 && <li>… 等共 {deleteTargets.length} 个</li>}
                </ul>
              </div>
            }
            onConfirm={doDelete}
            onClose={() => setDeleteTargets(null)}
          />
        )}

        {(toast || busy) && (
          <div className="pointer-events-none absolute bottom-3 right-3 z-30 max-w-md rounded bg-black/80 px-3 py-1.5 text-xs text-neutral-200 shadow-lg">
            {busy ? '处理中…' : toast}
          </div>
        )}
      </div>
    </div>
  )
}
