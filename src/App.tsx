import { useEffect, useMemo, useRef } from 'react'
import { Toolbar } from '@/components/Toolbar'
import { Sidebar } from '@/components/Sidebar'
import { ThumbnailGrid } from '@/components/ThumbnailGrid'
import { SingleView } from '@/components/SingleView'
import { CompareView } from '@/components/CompareView'
import { CompareGrid } from '@/components/CompareGrid'
import { Filmstrip } from '@/components/Filmstrip'
import { HelpOverlay } from '@/components/HelpOverlay'
import { OpenFolderDialog } from '@/components/OpenFolderDialog'
import { EmptyState } from '@/components/EmptyState'
import { useKeyboard } from '@/hooks/useKeyboard'
import { getNavList, useAppStore } from '@/store/appStore'
import { getFSProvider } from '@/lib/fs-provider'

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
  const physicalFullscreen = useAppStore((s) => s.physicalFullscreen)
  const notice = useAppStore((s) => s.notice)
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

  // 主进程 CLI 下发（cli-open）：首次启动参数与单实例转发共用
  useEffect(() => {
    const provider = getFSProvider()
    if (!provider.onCliOpen) return
    return provider.onCliOpen((payload) => void useAppStore.getState().applyCliOpen(payload))
  }, [])

  const hasImages = images.length > 0
  // 单格控件全屏（双击链 L1，'single'|'A'|'B'|格索引）：隐藏侧栏与胶片条，只留该格图像
  const hideChrome = fullscreenCell !== null
  // 物理全屏 = 真全屏：卸载一切应用 chrome（工具栏/侧栏/胶片条），只留图像 + 浮层 + 悬浮迷你条。
  // 不改 sidebarOpen/filmstripOpen 本身，退出后自然恢复原面板可见性；fullscreenchange 同步保证 Esc 退出同样恢复。
  const physical = physicalFullscreen

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--tv-bg)] text-[var(--tv-text)]">
      {!physical && <Toolbar />}
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && !hideChrome && !physical && <Sidebar />}
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="min-h-0 flex-1">
            {loading && (
              <div className="flex h-full items-center justify-center text-sm text-[var(--tv-text-dim)]">
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
          {filmstripOpen && hasImages && !hideChrome && !physical && <Filmstrip />}
        </div>
      </div>
      {/* 一次性操作提示（如对比导航无可切换项）：3s 自动消失 */}
      {notice && (
        <div data-notice className="fixed bottom-6 left-1/2 z-50 max-w-md -translate-x-1/2 rounded bg-black/80 px-3 py-1.5 text-xs text-neutral-200 shadow-lg">
          {notice}
        </div>
      )}
      <HelpOverlay />
      <OpenFolderDialog />
    </div>
  )
}
