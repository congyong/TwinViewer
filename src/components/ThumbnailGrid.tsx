import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardPaste, Copy, FolderPlus, RefreshCw, Trash2 } from 'lucide-react'
import type { ImageEntry } from '@/lib/fs-provider'
import type { FileOpResult } from '@/lib/fs-provider'
import { getVisibleImages, useAppStore } from '@/store/appStore'
import { pasteFiles, makeDirectory, trashEntries, writeSupported, writeUnsupportedReason } from '@/lib/file-ops'
import { ConfirmDialog, ContextMenu, NameDialog } from '@/components/FileOpsMenu'
import type { MenuItem } from '@/components/FileOpsMenu'
import { cn } from '@/lib/utils'

interface MenuState {
  x: number
  y: number
  target: ImageEntry | null
}

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
        'group relative flex cursor-pointer flex-col overflow-hidden rounded border bg-[#1f1f1f]',
        checked ? 'border-sky-500' : 'border-transparent hover:border-neutral-600',
        isCurrent && 'ring-1 ring-amber-500',
      )}
      style={{ width: size }}
      onDoubleClick={onOpen}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={`${entry.path}（双击进入单图模式，右键文件操作）`}
    >
      <div
        className="flex items-center justify-center overflow-hidden bg-[#161616]"
        style={{ width: size, height: size }}
      >
        {url ? (
          <img src={url} alt={entry.name} loading="lazy" className="h-full w-full object-contain" draggable={false} />
        ) : (
          <div className="text-xs text-neutral-600">…</div>
        )}
      </div>
      <div className="truncate px-1.5 py-1 text-center text-[11px] text-neutral-300">{entry.name}</div>
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

export function ThumbnailGrid() {
  const images = useAppStore((s) => s.images)
  const dir = useAppStore((s) => s.dir)
  const currentPath = useAppStore((s) => s.currentPath)
  const recursive = useAppStore((s) => s.recursive)
  const formatFilter = useAppStore((s) => s.formatFilter)
  const sortKey = useAppStore((s) => s.sortKey)
  const sortAsc = useAppStore((s) => s.sortAsc)
  const thumbSize = useAppStore((s) => s.thumbSize)
  const checked = useAppStore((s) => s.checked)
  const currentId = useAppStore((s) => s.currentId)
  const providerKind = useAppStore((s) => s.providerKind)
  const clipboard = useAppStore((s) => s.clipboard)
  const toggleChecked = useAppStore((s) => s.toggleChecked)
  const enterSingle = useAppStore((s) => s.enterSingle)
  const setCurrent = useAppStore((s) => s.setCurrent)
  const setClipboard = useAppStore((s) => s.setClipboard)
  const rescan = useAppStore((s) => s.rescan)

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [nameDialogOpen, setNameDialogOpen] = useState(false)
  const [deleteTargets, setDeleteTargets] = useState<ImageEntry[] | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const visible = useMemo(
    () => getVisibleImages({ images, dir, currentPath, recursive, formatFilter, sortKey, sortAsc }),
    [images, dir, currentPath, recursive, formatFilter, sortKey, sortAsc],
  )
  const checkedSet = useMemo(() => new Set(checked), [checked])

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

  const menuItems: MenuItem[] = menu?.target
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

  return (
    <div
      className="relative h-full overflow-y-auto p-3"
      onContextMenu={(e) => {
        e.preventDefault()
        if ((e.target as HTMLElement).closest('[data-thumb]')) return
        setMenu({ x: e.clientX, y: e.clientY, target: null })
      }}
    >
      {visible.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-neutral-500">
          {images.length === 0
            ? '当前文件夹没有图片'
            : '当前目录/过滤条件下没有图片（可切换目录或调整「含子文件夹」）'}
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
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
                setMenu({ x: e.clientX, y: e.clientY, target: entry })
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
              <ul className="mt-1 space-y-0.5 text-neutral-400">
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
  )
}
