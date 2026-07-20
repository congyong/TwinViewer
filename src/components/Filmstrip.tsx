import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ImageEntry } from '@/lib/fs-provider'
import { getNavList, useAppStore } from '@/store/appStore'
import { cn } from '@/lib/utils'

const StripItem = memo(function StripItem({
  entry,
  checked,
  mark,
  isCurrent,
  onClick,
  onDoubleClick,
  onToggle,
}: {
  entry: ImageEntry
  checked: boolean
  mark: 'A' | 'B' | null
  isCurrent: boolean
  onClick: () => void
  onDoubleClick: () => void
  onToggle: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let cancelled = false
    const io = new IntersectionObserver(
      (es) => {
        if (es[0].isIntersecting) {
          io.disconnect()
          void entry.getUrl().then((u) => {
            if (!cancelled) setUrl(u)
          })
        }
      },
      { rootMargin: '300px' },
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
      className={cn(
        'relative h-[74px] w-[74px] shrink-0 cursor-pointer overflow-hidden rounded border bg-[var(--tv-well)]',
        mark === 'A' && 'border-sky-500 ring-1 ring-sky-500',
        mark === 'B' && 'border-orange-500 ring-1 ring-orange-500',
        !mark && 'border-transparent hover:border-[var(--tv-border2)]',
        isCurrent && !mark && 'border-amber-500',
      )}
      title={entry.name}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {url && <img src={url} alt={entry.name} className="h-full w-full object-contain" draggable={false} />}
      {mark && (
        <span
          className={cn(
            'absolute left-0.5 top-0.5 rounded px-1 text-[10px] font-bold text-white',
            mark === 'A' ? 'bg-sky-600' : 'bg-orange-600',
          )}
        >
          {mark}
        </span>
      )}
      <input
        type="checkbox"
        className={cn(
          'absolute bottom-0.5 right-0.5 h-3.5 w-3.5 cursor-pointer accent-sky-500',
          checked ? 'opacity-100' : 'opacity-30 hover:opacity-100',
        )}
        checked={checked}
        onClick={(e) => e.stopPropagation()}
        onChange={onToggle}
        title="勾选"
      />
    </div>
  )
})

export function Filmstrip() {
  const images = useAppStore((s) => s.images)
  const dir = useAppStore((s) => s.dir)
  const currentPath = useAppStore((s) => s.currentPath)
  const recursive = useAppStore((s) => s.recursive)
  const formatFilter = useAppStore((s) => s.formatFilter)
  const sortKey = useAppStore((s) => s.sortKey)
  const sortAsc = useAppStore((s) => s.sortAsc)
  const navScope = useAppStore((s) => s.navScope)
  const checked = useAppStore((s) => s.checked)
  const viewMode = useAppStore((s) => s.viewMode)
  const currentId = useAppStore((s) => s.currentId)
  const slotA = useAppStore((s) => s.slotA)
  const slotB = useAppStore((s) => s.slotB)
  const activeSlot = useAppStore((s) => s.activeSlot)
  const gridIds = useAppStore((s) => s.gridIds)
  const gridActiveIdx = useAppStore((s) => s.gridActiveIdx)
  const setNavScope = useAppStore((s) => s.setNavScope)
  const toggleChecked = useAppStore((s) => s.toggleChecked)
  const enterSingle = useAppStore((s) => s.enterSingle)
  const setSlot = useAppStore((s) => s.setSlot)
  const setCurrent = useAppStore((s) => s.setCurrent)
  const setGridCellImage = useAppStore((s) => s.setGridCellImage)

  const navList = useMemo(
    () =>
      getNavList({
        images,
        dir,
        currentPath,
        recursive,
        formatFilter,
        sortKey,
        sortAsc,
        navScope,
        checked,
      }),
    [images, dir, currentPath, recursive, formatFilter, sortKey, sortAsc, navScope, checked],
  )
  const checkedSet = useMemo(() => new Set(checked), [checked])

  const activeId =
    viewMode === 'compare'
      ? activeSlot === 'A'
        ? slotA
        : slotB
      : viewMode === 'grid'
        ? (gridIds[gridActiveIdx] ?? null)
        : currentId
  const activeRef = useRef<HTMLDivElement>(null)

  // 激活项滚动到可视区
  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
  }, [activeId])

  const handleClick = (id: string) => {
    if (viewMode === 'compare') {
      // XnView 方式：点击切换当前激活侧（A 或 B）的图片
      setSlot(activeSlot, id)
    } else if (viewMode === 'grid') {
      // 网格模式：点击替换激活格的图片（若已在其他格则交换）
      setGridCellImage(gridActiveIdx, id)
    } else if (viewMode === 'single') {
      enterSingle(id)
    } else {
      // 浏览模式：单击 = 选中并滚动定位（与网格联动）
      setCurrent(id)
    }
  }

  const handleDoubleClick = (id: string) => {
    if (viewMode === 'browse') enterSingle(id)
  }

  return (
    <div data-chrome="filmstrip" className="shrink-0 border-t border-border bg-[var(--tv-panel)]">
      <div className="flex items-center gap-3 px-3 pt-1.5 text-xs text-[var(--tv-text-dim)]">
        <span>导航范围：</span>
        <div className="inline-flex overflow-hidden rounded border border-[var(--tv-border2)]">
          <button
            className={cn('px-2.5 py-0.5', navScope === 'all' ? 'bg-sky-600 text-white' : 'bg-transparent hover:bg-[var(--tv-hover)]')}
            onClick={() => setNavScope('all')}
          >
            全部
          </button>
          <button
            className={cn('px-2.5 py-0.5', navScope === 'checked' ? 'bg-sky-600 text-white' : 'bg-transparent hover:bg-[var(--tv-hover)]')}
            onClick={() => setNavScope('checked')}
            title="胶片条与 ←/→ 导航仅在勾选项中循环"
          >
            仅勾选
          </button>
        </div>
        <span>
          {navList.length} 项{navScope === 'checked' ? `（已勾选 ${checked.length}）` : ''}
        </span>
        {viewMode === 'compare' && (
          <span className="text-[var(--tv-text-faint)]">
            点击切换 {activeSlot} 槽图片 · Tab 切换激活侧 · A/B 键选定激活侧
          </span>
        )}
        {viewMode === 'grid' && (
          <span className="text-[var(--tv-text-faint)]">
            点击替换第 {gridActiveIdx + 1} 格图片 · Tab / 数字键切换激活格 · N 下一组
          </span>
        )}
      </div>
      <div className="flex gap-1.5 overflow-x-auto p-2">
        {navList.length === 0 && (
          <div className="py-4 text-xs text-[var(--tv-text-faint)]">
            {navScope === 'checked' ? '没有勾选项 — 在网格或胶片条中勾选图片' : '无图片'}
          </div>
        )}
        {navList.map((entry) => {
          const mark = entry.id === slotA ? 'A' : entry.id === slotB ? 'B' : null
          const isActive = entry.id === activeId
          return (
            <div key={entry.id} ref={isActive ? activeRef : undefined}>
              <StripItem
                entry={entry}
                checked={checkedSet.has(entry.id)}
                mark={mark}
                isCurrent={isActive}
                onClick={() => handleClick(entry.id)}
                onDoubleClick={() => handleDoubleClick(entry.id)}
                onToggle={() => toggleChecked(entry.id)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
