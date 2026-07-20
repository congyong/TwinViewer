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
  const physicalFullscreen = useAppStore((s) => s.physicalFullscreen)
  const fullscreenDblClick = useAppStore((s) => s.fullscreenDblClick)

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
      <div className="flex h-full items-center justify-center text-sm text-[var(--tv-text-faint)]">
        没有可显示的图片
      </div>
    )
  }

  // 单图控件全屏（双击 / F 进入；双击→物理全屏，物理中双击无第三层；Esc / F 退出）
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
            onToggleFullscreen={() => fullscreenDblClick('single')}
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
          extra="控件全屏（双击→物理全屏）"
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
        {physicalFullscreen && (
          <FullscreenMiniBar name={entry.name} onExit={() => setFullscreenCell(null)} />
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
