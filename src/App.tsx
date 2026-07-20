import { useEffect, useMemo, useRef } from 'react'
import { Toolbar } from '@/components/Toolbar'
import { Sidebar } from '@/components/Sidebar'
import { ThumbnailGrid } from '@/components/ThumbnailGrid'
import { SingleView } from '@/components/SingleView'
import { CompareView } from '@/components/CompareView'
import { CompareGrid } from '@/components/CompareGrid'
import { Filmstrip } from '@/components/Filmstrip'
import { HelpOverlay } from '@/components/HelpOverlay'
import { EmptyState } from '@/components/EmptyState'
import { useKeyboard } from '@/hooks/useKeyboard'
import { getNavList, useAppStore } from '@/store/appStore'

export default function App() {
  useKeyboard()

  const viewMode = useAppStore((s) => s.viewMode)
  const images = useAppStore((s) => s.images)
  const dir = useAppStore((s) => s.dir)
  const currentPath = useAppStore((s) => s.currentPath)
  const recursive = useAppStore((s) => s.recursive)
  const loading = useAppStore((s) => s.loading)
  const loadError = useAppStore((s) => s.loadError)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const filmstripOpen = useAppStore((s) => s.filmstripOpen)
  const formatFilter = useAppStore((s) => s.formatFilter)
  const sortKey = useAppStore((s) => s.sortKey)
  const sortAsc = useAppStore((s) => s.sortAsc)
  const navScope = useAppStore((s) => s.navScope)
  const checked = useAppStore((s) => s.checked)
  const fullscreenCell = useAppStore((s) => s.fullscreenCell)
  const reconcileNav = useAppStore((s) => s.reconcileNav)
  const revokeAll = useAppStore((s) => s.revokeAll)

  const navIds = useMemo(
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
      }).map((e) => e.id),
    [images, dir, currentPath, recursive, formatFilter, sortKey, sortAsc, navScope, checked],
  )
  const prevNavIdsRef = useRef<string[]>(navIds)

  // 勾选/范围变化实时生效：当前图片掉出集合时跳到集合内最近项
  useEffect(() => {
    reconcileNav(prevNavIdsRef.current)
    prevNavIdsRef.current = navIds
  }, [navIds, reconcileNav])

  // 组件卸载统一释放 object URL
  useEffect(() => {
    return () => revokeAll()
  }, [revokeAll])

  // 物理全屏状态以浏览器事件为准（用户可能用 F11 / Esc 等途径进出）
  useEffect(() => {
    const sync = () => useAppStore.setState({ physicalFullscreen: !!document.fullscreenElement })
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  const hasImages = images.length > 0
  // 单图应用内全屏：隐藏侧栏与胶片条（对比/网格单格全屏保留外框，与既有行为一致）
  const hideChrome = fullscreenCell === 'single'

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#1e1e1e] text-neutral-200">
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && !hideChrome && <Sidebar />}
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="min-h-0 flex-1">
            {loading && (
              <div className="flex h-full items-center justify-center text-sm text-neutral-400">
                正在扫描图片…
              </div>
            )}
            {!loading && loadError && (
              <div className="flex h-full items-center justify-center text-sm text-red-400">
                加载失败：{loadError}
              </div>
            )}
            {!loading && !loadError && !hasImages && <EmptyState />}
            {!loading && !loadError && hasImages && viewMode === 'browse' && <ThumbnailGrid />}
            {!loading && !loadError && hasImages && viewMode === 'single' && <SingleView />}
            {!loading && !loadError && hasImages && viewMode === 'compare' && <CompareView />}
            {!loading && !loadError && hasImages && viewMode === 'grid' && <CompareGrid />}
          </main>
          {filmstripOpen && hasImages && !hideChrome && <Filmstrip />}
        </div>
      </div>
      <HelpOverlay />
    </div>
  )
}
