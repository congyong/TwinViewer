import { useEffect, useMemo, useRef, useState } from 'react'
import { newTransform, useAppStore } from '@/store/appStore'
import { ViewerPane } from '@/components/ViewerPane'
import { StatusBar } from '@/components/StatusBar'
import { InfoOverlay } from '@/components/InfoOverlay'
import { FullscreenMiniBar } from '@/components/FullscreenMiniBar'

interface LayoutSpec {
  rows: number
  cols: number
}

/** 自动布局候选（行 × 列） */
const AUTO_CANDIDATES: LayoutSpec[] = [
  { rows: 1, cols: 2 },
  { rows: 2, cols: 1 },
  { rows: 1, cols: 3 },
  { rows: 3, cols: 1 },
  { rows: 2, cols: 2 },
  { rows: 2, cols: 3 },
  { rows: 3, cols: 2 },
  { rows: 3, cols: 3 },
]

/** 自动布局：候选中 rows*cols >= n 的最小格子数；并列时行列比最接近容器宽高比 */
function autoLayout(count: number, aspect: number): LayoutSpec {
  let best: LayoutSpec = { rows: 3, cols: 3 }
  let bestCells = Infinity
  let bestFit = Infinity
  for (const c of AUTO_CANDIDATES) {
    const cells = c.rows * c.cols
    if (cells < count) continue
    const fit = Math.abs(c.cols / c.rows - aspect)
    if (cells < bestCells || (cells === bestCells && fit < bestFit)) {
      best = c
      bestCells = cells
      bestFit = fit
    }
  }
  return best
}

/** 多图网格对比：勾选 ≥3 张进入；每格一个 ViewerPane，同步/独立两档，支持单格全屏 */
export function CompareGrid() {
  const images = useAppStore((s) => s.images)
  const gridIds = useAppStore((s) => s.gridIds)
  const gridActiveIdx = useAppStore((s) => s.gridActiveIdx)
  const gridLayout = useAppStore((s) => s.gridLayout)
  const gridSync = useAppStore((s) => s.gridSync)
  const gridTransforms = useAppStore((s) => s.gridTransforms)
  const sharedTransform = useAppStore((s) => s.sharedTransform)
  const fullscreenCell = useAppStore((s) => s.fullscreenCell)
  // 浮层显隐 = 基本信息（I 键）或直方图（工具栏开关）任一开启
  const infoVisible = useAppStore((s) => s.infoVisible || s.histoVisible)
  const setGridActiveIdx = useAppStore((s) => s.setGridActiveIdx)
  const setSharedTransform = useAppStore((s) => s.setSharedTransform)
  const setGridTransform = useAppStore((s) => s.setGridTransform)
  const setFullscreenCell = useAppStore((s) => s.setFullscreenCell)

  const [metas, setMetas] = useState<Record<string, { w: number; h: number }>>({})
  const [zooms, setZooms] = useState<Record<number, number>>({})

  const byId = useMemo(() => new Map(images.map((e) => [e.id, e])), [images])
  const entries = useMemo(
    () => gridIds.map((id) => byId.get(id)).filter((e): e is NonNullable<typeof e> => !!e),
    [gridIds, byId],
  )

  // 容器宽高比（自动布局判据之一）
  const containerRef = useRef<HTMLDivElement>(null)
  const [aspect, setAspect] = useState(1.5)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((es) => {
      const r = es[0].contentRect
      if (r.height > 0) setAspect(r.width / r.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const layout = useMemo<LayoutSpec>(() => {
    const m = /^(\d)x(\d)$/.exec(gridLayout)
    if (m) return { rows: parseInt(m[1], 10), cols: parseInt(m[2], 10) }
    return autoLayout(entries.length, aspect)
  }, [gridLayout, entries.length, aspect])

  // 手动布局格子数可能少于图片数：只显示前 rows*cols 张（N 换组可看其余）
  const capacity = Math.max(layout.rows * layout.cols, 1)
  const visibleEntries = entries.slice(0, capacity)
  const activeIdx = Math.min(gridActiveIdx, Math.max(entries.length - 1, 0))
  const activeEntry = activeIdx >= 0 ? (entries[activeIdx] ?? null) : null

  const cellTransform = (i: number) =>
    gridSync ? sharedTransform : (gridTransforms[i] ?? newTransform())
  const cellOnChange = (i: number) => (t: Parameters<typeof setSharedTransform>[0]) =>
    gridSync ? setSharedTransform(t) : setGridTransform(i, t)

  const fsIdx = fullscreenCell !== null ? parseInt(fullscreenCell, 10) : -1
  const fsEntry = fsIdx >= 0 && fsIdx < entries.length ? entries[fsIdx] : null

  if (entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-500">
        没有选中的图片 — 请在浏览模式勾选至少 3 张后点击「对比选中」
      </div>
    )
  }

  // 单格全屏（双击 / F 进入，Esc / F / 双击退出）
  if (fsEntry) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="relative min-h-0 flex-1">
          <ViewerPane
            className="h-full"
            layers={[
              {
                entry: fsEntry,
                onMeta: (w, h) => setMetas((m) => ({ ...m, [fsEntry.id]: { w, h } })),
              },
            ]}
            transform={cellTransform(fsIdx)}
            onTransformChange={cellOnChange(fsIdx)}
            onEffectiveZoom={(z) => setZooms((s) => ({ ...s, [fsIdx]: z }))}
            onToggleFullscreen={() => setFullscreenCell(null)}
            probeSlot={String(fsIdx + 1)}
          />
          {infoVisible && (
            <InfoOverlay
              entry={fsEntry}
              meta={metas[fsEntry.id] ?? null}
              zoom={zooms[fsIdx] ?? 1}
              index={fsIdx}
              total={entries.length}
            />
          )}
          <FullscreenMiniBar
            label={String(fsIdx + 1)}
            labelClass="text-sky-400"
            name={fsEntry.name}
            onExit={() => setFullscreenCell(null)}
          />
        </div>
        <StatusBar
          entry={fsEntry}
          meta={metas[fsEntry.id] ?? null}
          zoom={zooms[fsIdx] ?? 1}
          index={fsIdx}
          total={entries.length}
          extra="单格全屏"
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={containerRef}
        className="grid min-h-0 flex-1 gap-1 bg-[#161616] p-1"
        style={{
          gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
        }}
      >
        {visibleEntries.map((entry, i) => (
          <div key={entry.id} className="relative min-h-0 min-w-0">
            <ViewerPane
              className="h-full"
              layers={[
                {
                  entry,
                  onMeta: (w, h) => setMetas((m) => ({ ...m, [entry.id]: { w, h } })),
                },
              ]}
              transform={cellTransform(i)}
              onTransformChange={cellOnChange(i)}
              label={String(i + 1)}
              labelColor={i === activeIdx ? 'bg-sky-600' : 'bg-neutral-600'}
              title={entry.name}
              active={i === activeIdx}
              onActivate={() => setGridActiveIdx(i)}
              onEffectiveZoom={(z) => setZooms((s) => ({ ...s, [i]: z }))}
              onToggleFullscreen={() => setFullscreenCell(String(i))}
              probeSlot={String(i + 1)}
            />
            {infoVisible && (
              <InfoOverlay
                entry={entry}
                meta={metas[entry.id] ?? null}
                zoom={zooms[i] ?? 1}
                index={i}
                total={entries.length}
                offsetTop
              />
            )}
          </div>
        ))}
      </div>
      <StatusBar
        entry={activeEntry}
        meta={activeEntry ? (metas[activeEntry.id] ?? null) : null}
        zoom={zooms[activeIdx] ?? 1}
        index={Math.max(0, activeIdx)}
        total={entries.length}
        extra={`网格 ${entries.length} 张 · ${gridSync ? '同步' : '独立'} · 点击 / Tab / 数字键切换激活格 · F 全屏 · N 下一组`}
      />
    </div>
  )
}
