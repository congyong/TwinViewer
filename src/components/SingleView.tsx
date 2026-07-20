import { useMemo, useState } from 'react'
import { getNavList, useAppStore } from '@/store/appStore'
import { ViewerPane } from '@/components/ViewerPane'
import { StatusBar } from '@/components/StatusBar'
import { InfoOverlay } from '@/components/InfoOverlay'
import { FullscreenMiniBar } from '@/components/FullscreenMiniBar'

export function SingleView() {
  const images = useAppStore((s) => s.images)
  const dir = useAppStore((s) => s.dir)
  const currentPath = useAppStore((s) => s.currentPath)
  const recursive = useAppStore((s) => s.recursive)
  const formatFilter = useAppStore((s) => s.formatFilter)
  const sortKey = useAppStore((s) => s.sortKey)
  const sortAsc = useAppStore((s) => s.sortAsc)
  const navScope = useAppStore((s) => s.navScope)
  const checked = useAppStore((s) => s.checked)
  const currentId = useAppStore((s) => s.currentId)
  const transform = useAppStore((s) => s.singleTransform)
  const setTransform = useAppStore((s) => s.setSingleTransform)
  // 浮层显隐 = 基本信息（I 键）或直方图（工具栏开关）任一开启
  const infoVisible = useAppStore((s) => s.infoVisible || s.histoVisible)
  const fullscreenCell = useAppStore((s) => s.fullscreenCell)
  const setFullscreenCell = useAppStore((s) => s.setFullscreenCell)

  const [meta, setMeta] = useState<{ w: number; h: number } | null>(null)
  const [effZoom, setEffZoom] = useState(1)

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
  const entry = useMemo(
    () => navList.find((e) => e.id === currentId) ?? images.find((e) => e.id === currentId) ?? null,
    [navList, images, currentId],
  )
  const index = entry ? navList.findIndex((e) => e.id === entry.id) : -1

  if (!entry) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-500">
        没有可显示的图片
      </div>
    )
  }

  // 应用内单图全屏（F 进入，Esc / F / 双击退出；隐藏侧栏与胶片条由 App 控制）
  if (fullscreenCell === 'single') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="relative min-h-0 flex-1">
          <ViewerPane
            className="h-full"
            layers={[{ entry }]}
            transform={transform}
            onTransformChange={setTransform}
            onMeta={(w, h) => setMeta({ w, h })}
            onEffectiveZoom={setEffZoom}
            onToggleFullscreen={() => setFullscreenCell(null)}
            probeSlot="—"
          />
          {infoVisible && (
            <InfoOverlay
              entry={entry}
              meta={meta}
              zoom={effZoom}
              index={Math.max(0, index)}
              total={navList.length}
            />
          )}
          <FullscreenMiniBar name={entry.name} onExit={() => setFullscreenCell(null)} />
        </div>
        <StatusBar
          entry={entry}
          meta={meta}
          zoom={effZoom}
          index={Math.max(0, index)}
          total={navList.length}
          extra="单格全屏"
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <ViewerPane
          className="h-full"
          layers={[{ entry }]}
          transform={transform}
          onTransformChange={setTransform}
          title={entry.name}
          onMeta={(w, h) => setMeta({ w, h })}
          onEffectiveZoom={setEffZoom}
          probeSlot="—"
        />
        {infoVisible && (
          <InfoOverlay
            entry={entry}
            meta={meta}
            zoom={effZoom}
            index={Math.max(0, index)}
            total={navList.length}
          />
        )}
      </div>
      <StatusBar
        entry={entry}
        meta={meta}
        zoom={effZoom}
        index={Math.max(0, index)}
        total={navList.length}
        extra={transform.mode === 'fit' ? '适应窗口' : undefined}
      />
    </div>
  )
}
