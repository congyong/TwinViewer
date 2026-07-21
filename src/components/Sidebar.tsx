import { useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Star,
  Trash2,
  MonitorPlay,
  Globe,
  Pipette,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import type { DirNode } from '@/lib/dir-tree'
import { relDirOf } from '@/lib/dir-tree'
import { useAppStore, getVisibleImages } from '@/store/appStore'
import { FolderIcon } from '@/components/FolderIcon'
import { cn } from '@/lib/utils'

/** 文件夹树节点（递归渲染，子层懒加载） */
function TreeNode({ name, relPath, depth, imageCount, hasChildren }: DirNode & { depth: number }) {
  const expanded = useAppStore((s) => s.treeExpanded[relPath] ?? relPath === '')
  const children = useAppStore((s) => s.treeChildren[relPath])
  const currentPath = useAppStore((s) => s.currentPath)
  const toggleTreeNode = useAppStore((s) => s.toggleTreeNode)
  const openTreeNode = useAppStore((s) => s.openTreeNode)
  const isCurrent = currentPath === relPath

  return (
    <div>
      <div
        className={cn(
          'flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-xs hover:bg-[var(--tv-hover)]',
          isCurrent && 'bg-sky-600/30 text-sky-200',
        )}
        style={{ paddingLeft: depth * 12 + 2 }}
        onClick={() => {
          // 点树节点 = 看该目录的网格：已扫描范围内快速过滤；根外（祖先链）由 openTreeNode 走扫描打开
          openTreeNode(relPath)
        }}
        title={relPath === '' ? '根目录' : relPath}
      >
        <button
          className={cn('shrink-0 text-[var(--tv-text-dim)]', !hasChildren && 'invisible')}
          onClick={(e) => {
            e.stopPropagation()
            toggleTreeNode(relPath)
          }}
          title={expanded ? '折叠' : '展开'}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <FolderIcon className="h-3.5 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="shrink-0 rounded bg-[var(--tv-badge)] px-1 text-[10px] text-[var(--tv-text-dim)]" title="本层图片数（回退模式为含子目录）">
          {imageCount}
        </span>
      </div>
      {expanded && children === undefined && (
        <div className="py-0.5 text-[11px] text-[var(--tv-text-faint)]" style={{ paddingLeft: (depth + 1) * 12 + 18 }}>
          加载中…
        </div>
      )}
      {expanded &&
        children?.map((c) => <TreeNode key={c.relPath} {...c} depth={depth + 1} />)}
      {expanded && children !== undefined && children.length === 0 && (
        <div className="py-0.5 text-[11px] text-[var(--tv-text-faint)]" style={{ paddingLeft: (depth + 1) * 12 + 18 }}>
          （无子目录）
        </div>
      )}
    </div>
  )
}

export function Sidebar() {
  const dir = useAppStore((s) => s.dir)
  const images = useAppStore((s) => s.images)
  const checked = useAppStore((s) => s.checked)
  const providerKind = useAppStore((s) => s.providerKind)
  const favorites = useAppStore((s) => s.favorites)
  const addFavorite = useAppStore((s) => s.addFavorite)
  const removeFavorite = useAppStore((s) => s.removeFavorite)
  const openPath = useAppStore((s) => s.openPath)
  const formatFilter = useAppStore((s) => s.formatFilter)
  const sortKey = useAppStore((s) => s.sortKey)
  const sortAsc = useAppStore((s) => s.sortAsc)
  const currentPath = useAppStore((s) => s.currentPath)
  const recursive = useAppStore((s) => s.recursive)
  const treeChildren = useAppStore((s) => s.treeChildren)
  const loadTreeChildren = useAppStore((s) => s.loadTreeChildren)
  const ancestors = useAppStore((s) => s.ancestors)
  const samples = useAppStore((s) => s.samples)
  const clearSamples = useAppStore((s) => s.clearSamples)

  const [samplesOpen, setSamplesOpen] = useState(true)

  const visibleCount = getVisibleImages({
    images,
    dir,
    currentPath,
    recursive,
    formatFilter,
    sortKey,
    sortAsc,
  }).length

  // 打开文件夹后预载根层子目录
  useEffect(() => {
    if (dir && treeChildren[''] === undefined) void loadTreeChildren('')
  }, [dir, treeChildren, loadTreeChildren])

  const rootName = dir
    ? dir.dirPath
      ? (dir.dirPath.split(/[\\/]/).filter(Boolean).pop() ?? dir.dirPath)
      : dir.name
    : ''

  // 根节点显示本层图片数
  const rootDirectCount = dir ? images.filter((e) => relDirOf(e, dir) === '').length : 0

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border bg-[var(--tv-panel)] p-3 text-sm">
      <div>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-[var(--tv-text-dim)]">
          <FolderOpen className="h-3.5 w-3.5" /> 文件夹树
        </div>
        {dir ? (
          <>
            <div className="mb-1 break-all text-[11px] text-[var(--tv-text-faint)]" title={dir.name}>
              {dir.name}
            </div>
            <div className="max-h-72 overflow-y-auto rounded bg-[var(--tv-soft)] py-1">
              {providerKind === 'browser' && (
                <div className="px-2 py-1 text-[10px] leading-snug text-[var(--tv-text-faint)]">
                  浏览器模式无法访问上级目录
                </div>
              )}
              {ancestors.map((a, i) => (
                <TreeNode key={a.relPath} {...a} depth={Math.min(i, 3)} />
              ))}
              {ancestors.length > 0 && <div className="mx-2 my-0.5 border-t border-[var(--tv-line)]" />}
              <TreeNode
                name={rootName}
                relPath=""
                depth={Math.min(ancestors.length, 3)}
                imageCount={rootDirectCount}
                hasChildren
              />
            </div>
            <div className="mt-1 space-y-0.5 text-xs text-[var(--tv-text-dim)]">
              <div>图片总数：{images.length}</div>
              <div>当前显示：{visibleCount}</div>
              <div>已勾选：{checked.length}</div>
              <div className="flex items-center gap-1">
                {providerKind === 'electron' ? (
                  <>
                    <MonitorPlay className="h-3 w-3" /> 桌面模式（原生文件系统）
                  </>
                ) : (
                  <>
                    <Globe className="h-3 w-3" /> 浏览器模式
                  </>
                )}
              </div>
            </div>
            {providerKind === 'electron' && (
              <Button size="sm" variant="outline" className="mt-2 h-7 w-full text-xs" onClick={addFavorite}>
                <Star className="mr-1 h-3.5 w-3.5" /> 收藏当前文件夹
              </Button>
            )}
          </>
        ) : (
          <div className="text-xs text-[var(--tv-text-faint)]">尚未打开文件夹</div>
        )}
      </div>

      <Separator />

      <div className="min-h-0 flex-1">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-[var(--tv-text-dim)]">
          <Star className="h-3.5 w-3.5" /> 收藏
        </div>
        {favorites.length === 0 ? (
          <div className="text-xs text-[var(--tv-text-faint)]">
            {providerKind === 'electron'
              ? '暂无收藏。打开文件夹后可收藏。'
              : '收藏夹仅在桌面（Electron）模式下可用。'}
          </div>
        ) : (
          <ul className="space-y-1">
            {favorites.map((f) => (
              <li key={f.path} className="group flex items-center gap-1">
                <button
                  className="min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-hover)]"
                  title={f.path}
                  onClick={() => void openPath(f.path)}
                >
                  {f.path}
                </button>
                <button
                  className="hidden shrink-0 text-[var(--tv-text-faint)] hover:text-red-400 group-hover:block"
                  title="移除收藏"
                  onClick={() => removeFavorite(f.path)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Separator />

      {/* ALT 颜色取样记录（最多 10 条，可折叠） */}
      <div>
        <button
          className="mb-1 flex w-full items-center gap-1.5 text-left text-xs font-semibold text-[var(--tv-text-dim)] hover:text-[var(--tv-text)]"
          onClick={() => setSamplesOpen((v) => !v)}
        >
          {samplesOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Pipette className="h-3.5 w-3.5" /> 取样记录（{samples.length}/10）
        </button>
        {samplesOpen &&
          (samples.length === 0 ? (
            <div className="text-xs text-[var(--tv-text-faint)]">按住 ALT 指向像素查看颜色，ALT+单击记录</div>
          ) : (
            <>
              <ul className="space-y-0.5">
                {samples.map((smp) => (
                  <li key={smp.seq} className="flex items-center gap-1.5 text-[11px] text-[var(--tv-text)]">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm border border-white/30"
                      style={{ backgroundColor: `rgb(${smp.r},${smp.g},${smp.b})` }}
                    />
                    <span className="shrink-0 text-[var(--tv-text-faint)]">#{smp.seq}</span>
                    <span className="shrink-0 text-sky-400">{smp.slot}</span>
                    <span className="min-w-0 truncate" title={smp.name}>
                      {smp.name}
                    </span>
                    <span className="shrink-0 text-[var(--tv-text-faint)]">
                      ({smp.x},{smp.y}) {smp.r},{smp.g},{smp.b}
                    </span>
                  </li>
                ))}
              </ul>
              <Button size="sm" variant="outline" className="mt-1.5 h-7 w-full text-xs" onClick={clearSamples}>
                清空
              </Button>
            </>
          ))}
      </div>
    </aside>
  )
}
