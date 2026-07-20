import { useCallback, useMemo, useRef, useState } from 'react'
import { getNavList, useAppStore } from '@/store/appStore'
import { ViewerPane } from '@/components/ViewerPane'
import { StatusBar } from '@/components/StatusBar'
import { InfoOverlay } from '@/components/InfoOverlay'
import { FullscreenMiniBar } from '@/components/FullscreenMiniBar'

export function CompareView() {
  const images = useAppStore((s) => s.images)
  const dir = useAppStore((s) => s.dir)
  const currentPath = useAppStore((s) => s.currentPath)
  const recursive = useAppStore((s) => s.recursive)
  const formatFilter = useAppStore((s) => s.formatFilter)
  const sortKey = useAppStore((s) => s.sortKey)
  const sortAsc = useAppStore((s) => s.sortAsc)
  const navScope = useAppStore((s) => s.navScope)
  const checked = useAppStore((s) => s.checked)
  const slotA = useAppStore((s) => s.slotA)
  const slotB = useAppStore((s) => s.slotB)
  const activeSlot = useAppStore((s) => s.activeSlot)
  const compareLayout = useAppStore((s) => s.compareLayout)
  const sync = useAppStore((s) => s.sync)
  const splitRatio = useAppStore((s) => s.splitRatio)
  const wipeRatio = useAppStore((s) => s.wipeRatio)
  const overlayOpacity = useAppStore((s) => s.overlayOpacity)
  const overlaySwapped = useAppStore((s) => s.overlaySwapped)
  const sharedTransform = useAppStore((s) => s.sharedTransform)
  const transformA = useAppStore((s) => s.transformA)
  const transformB = useAppStore((s) => s.transformB)
  const setSharedTransform = useAppStore((s) => s.setSharedTransform)
  const setTransformA = useAppStore((s) => s.setTransformA)
  const setTransformB = useAppStore((s) => s.setTransformB)
  const toggleActiveSlot = useAppStore((s) => s.toggleActiveSlot)
  const setSplitRatio = useAppStore((s) => s.setSplitRatio)
  const setWipeRatio = useAppStore((s) => s.setWipeRatio)
  // 浮层显隐 = 基本信息（I 键）或直方图（工具栏开关）任一开启
  const infoVisible = useAppStore((s) => s.infoVisible || s.histoVisible)
  const fullscreenCell = useAppStore((s) => s.fullscreenCell)
  const setFullscreenCell = useAppStore((s) => s.setFullscreenCell)

  const [metaA, setMetaA] = useState<{ w: number; h: number } | null>(null)
  const [metaB, setMetaB] = useState<{ w: number; h: number } | null>(null)
  const [zoomA, setZoomA] = useState(1)
  const [zoomB, setZoomB] = useState(1)

  const wrapRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  const byId = useMemo(() => new Map(images.map((e) => [e.id, e])), [images])
  const entryA = slotA ? byId.get(slotA) ?? null : null
  const entryB = slotB ? byId.get(slotB) ?? null : null

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

  const indexOf = useCallback((id: string | null) => (id ? navList.findIndex((e) => e.id === id) : -1), [navList])

  const activeEntry = activeSlot === 'A' ? entryA : entryB
  const activeMeta = activeSlot === 'A' ? metaA : metaB
  const activeZoom = activeSlot === 'A' ? zoomA : zoomB
  const activeIndex = activeEntry ? indexOf(activeEntry.id) : -1

  const onDividerDown = useCallback((e: React.PointerEvent) => {
    draggingRef.current = true
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }, [])
  const onDividerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current || !wrapRef.current) return
      const rect = wrapRef.current.getBoundingClientRect()
      setSplitRatio((e.clientX - rect.left) / rect.width)
    },
    [setSplitRatio],
  )
  const onDividerUp = useCallback(() => {
    draggingRef.current = false
  }, [])

  if (!entryA || !entryB) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-neutral-500">
        <p>请先在浏览模式勾选 2 张图片，或从单图模式按 A / B 键指定对比图。</p>
      </div>
    )
  }

  // 同步开启：两侧共享 transform（zoom 为各自图宽的比例，天然对齐）
  const tA = sync ? sharedTransform : transformA
  const tB = sync ? sharedTransform : transformB
  const onChangeA = sync ? setSharedTransform : setTransformA
  const onChangeB = sync ? setSharedTransform : setTransformB

  // 单格全屏：铺满整个对比区域，隐藏其他格与分隔条/手柄
  if (fullscreenCell === 'A' || fullscreenCell === 'B') {
    const isA = fullscreenCell === 'A'
    const fsEntry = isA ? entryA : entryB
    const fsMeta = isA ? metaA : metaB
    const fsZoom = isA ? zoomA : zoomB
    const fsTransform = isA ? tA : tB
    const fsOnChange = isA ? onChangeA : onChangeB
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="relative min-h-0 flex-1">
          <ViewerPane
            className="h-full"
            layers={[{ entry: fsEntry, onMeta: isA ? (w, h) => setMetaA({ w, h }) : (w, h) => setMetaB({ w, h }) }]}
            transform={fsTransform}
            onTransformChange={fsOnChange}
            onEffectiveZoom={isA ? setZoomA : setZoomB}
            onToggleFullscreen={() => setFullscreenCell(null)}
            probeSlot={fullscreenCell}
          />
          {infoVisible && (
            <InfoOverlay entry={fsEntry} meta={fsMeta} zoom={fsZoom} index={indexOf(fsEntry.id)} total={navList.length} />
          )}
          <FullscreenMiniBar
            label={fullscreenCell}
            labelClass={isA ? 'text-sky-400' : 'text-orange-400'}
            name={fsEntry.name}
            onExit={() => setFullscreenCell(null)}
          />
        </div>
        <StatusBar
          entry={fsEntry}
          meta={fsMeta}
          zoom={fsZoom}
          index={Math.max(0, indexOf(fsEntry.id))}
          total={navList.length}
          extra="单格全屏"
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={wrapRef} className="flex min-h-0 flex-1">
        {compareLayout === 'wipe' && (
          <div className="relative min-w-0 flex-1">
            <ViewerPane
              className="h-full"
              layers={[
                { entry: entryA, onMeta: (w, h) => setMetaA({ w, h }) },
                { entry: entryB, onMeta: (w, h) => setMetaB({ w, h }) },
              ]}
              transform={sharedTransform}
              onTransformChange={setSharedTransform}
              title={`${entryA.name} × ${entryB.name}`}
              onEffectiveZoom={(z) => {
                setZoomA(z)
                setZoomB(z)
              }}
              wipe={{ ratio: wipeRatio, onChange: setWipeRatio }}
              onToggleFullscreen={() => setFullscreenCell(activeSlot)}
              probeSlot={activeSlot}
              probeLayer={activeSlot === 'A' ? 0 : 1}
            />
            <div className="pointer-events-none absolute left-2 top-2 rounded bg-sky-600 px-2 py-0.5 text-xs font-bold text-white shadow">
              A
            </div>
            <div className="pointer-events-none absolute right-2 top-2 rounded bg-orange-600 px-2 py-0.5 text-xs font-bold text-white shadow">
              B
            </div>
            {infoVisible && activeEntry && (
              <InfoOverlay
                entry={activeEntry}
                meta={activeMeta}
                zoom={activeZoom}
                index={activeIndex}
                total={navList.length}
                offsetTop
              />
            )}
          </div>
        )}

        {compareLayout === 'side' && (
          <>
            <div className="relative min-w-0" style={{ width: `${splitRatio * 100}%` }}>
              <ViewerPane
                className="h-full"
                layers={[{ entry: entryA, onMeta: (w, h) => setMetaA({ w, h }) }]}
                transform={tA}
                onTransformChange={onChangeA}
                label="A"
                labelColor="bg-sky-600"
                title={entryA.name}
                active={activeSlot === 'A'}
                onActivate={() => activeSlot !== 'A' && toggleActiveSlot()}
                onEffectiveZoom={setZoomA}
                onToggleFullscreen={() => setFullscreenCell('A')}
                probeSlot="A"
              />
              {infoVisible && (
                <InfoOverlay entry={entryA} meta={metaA} zoom={zoomA} index={indexOf(slotA)} total={navList.length} offsetTop />
              )}
            </div>
            <div
              className="w-1.5 shrink-0 cursor-col-resize bg-[#333] hover:bg-sky-600"
              title="拖拽调整左右比例"
              onPointerDown={onDividerDown}
              onPointerMove={onDividerMove}
              onPointerUp={onDividerUp}
              onPointerCancel={onDividerUp}
            />
            <div className="relative min-w-0 flex-1">
              <ViewerPane
                className="h-full"
                layers={[{ entry: entryB, onMeta: (w, h) => setMetaB({ w, h }) }]}
                transform={tB}
                onTransformChange={onChangeB}
                label="B"
                labelColor="bg-orange-600"
                title={entryB.name}
                active={activeSlot === 'B'}
                onActivate={() => activeSlot !== 'B' && toggleActiveSlot()}
                onEffectiveZoom={setZoomB}
                onToggleFullscreen={() => setFullscreenCell('B')}
                probeSlot="B"
              />
              {infoVisible && (
                <InfoOverlay entry={entryB} meta={metaB} zoom={zoomB} index={indexOf(slotB)} total={navList.length} offsetTop />
              )}
            </div>
          </>
        )}

        {compareLayout === 'overlay' && (
          <div className="relative min-w-0 flex-1">
            <ViewerPane
              className="h-full"
              layers={
                overlaySwapped
                  ? [
                      { entry: entryB, onMeta: (w, h) => setMetaB({ w, h }) },
                      { entry: entryA, opacity: overlayOpacity, onMeta: (w, h) => setMetaA({ w, h }) },
                    ]
                  : [
                      { entry: entryA, onMeta: (w, h) => setMetaA({ w, h }) },
                      { entry: entryB, opacity: overlayOpacity, onMeta: (w, h) => setMetaB({ w, h }) },
                    ]
              }
              transform={sharedTransform}
              onTransformChange={setSharedTransform}
              label={overlaySwapped ? 'B + A' : 'A + B'}
              labelColor="bg-purple-600"
              title={`${entryA.name} × ${entryB.name}`}
              active
              onEffectiveZoom={(z) => {
                setZoomA(z)
                setZoomB(z)
              }}
              onToggleFullscreen={() => setFullscreenCell(activeSlot)}
              probeSlot={activeSlot}
              probeLayer={overlaySwapped ? (activeSlot === 'A' ? 1 : 0) : activeSlot === 'A' ? 0 : 1}
            />
            {infoVisible && activeEntry && (
              <InfoOverlay
                entry={activeEntry}
                meta={activeMeta}
                zoom={activeZoom}
                index={activeIndex}
                total={navList.length}
                offsetTop
              />
            )}
          </div>
        )}
      </div>
      <StatusBar
        entry={activeEntry}
        meta={activeMeta}
        zoom={activeZoom}
        index={Math.max(0, activeIndex)}
        total={navList.length}
        extra={`激活侧 ${activeSlot}${compareLayout === 'side' && sync ? ' · 同步中' : ''}`}
      />
    </div>
  )
}
