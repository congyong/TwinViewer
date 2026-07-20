/**
 * 差值热图窗格（diff 布局）：
 * - A/B 解码产物（decode-cache，blob 不污染 canvas）→ computeDiffBitmap 逐像素差值 → 单 canvas 显示
 * - 交互与 ViewerPane 对齐：滚轮锚点缩放 / 拖拽平移 / 双击走全屏链 / R·L 旋转（transform.rotation）
 * - 重算时机：仅源图（A/B bitmap）、容差、colormap 变化时重算（停手防抖 100ms）；缩放/平移只重绘不重算
 * - ALT 探针在 diff 下不支持（显示的是合成图而非源图，坐标会误导；从略）
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ImageEntry } from '@/lib/fs-provider'
import { clamp } from '@/lib/format'
import type { ViewTransform } from '@/store/appStore'
import { useAppStore } from '@/store/appStore'
import { getDecoded, peekDecoded, pinDecoded, type DecodedImage } from '@/lib/decode-cache'
import { computeDiffBitmap } from '@/lib/diffmap'
import { cn } from '@/lib/utils'

const MIN_ZOOM = 0.02
const MAX_ZOOM = 64

interface DiffPaneProps {
  entryA: ImageEntry
  entryB: ImageEntry
  transform: ViewTransform
  onTransformChange: (t: ViewTransform) => void
  title?: string
  onMeta?: (w: number, h: number) => void
  onEffectiveZoom?: (z: number) => void
  onToggleFullscreen?: () => void
  className?: string
}

export function DiffPane({
  entryA,
  entryB,
  transform,
  onTransformChange,
  title,
  onMeta,
  onEffectiveZoom,
  onToggleFullscreen,
  className,
}: DiffPaneProps) {
  const tolerance = useAppStore((s) => s.diffTolerance)
  const colormap = useAppStore((s) => s.diffColormap)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 })
  const [decoded, setDecoded] = useState<{ a: DecodedImage; b: DecodedImage } | null>(null)
  const [diffBmp, setDiffBmp] = useState<ImageBitmap | null>(null)
  const [computing, setComputing] = useState(false)
  const framePinsRef = useRef<(() => void)[]>([])
  const diffBmpRef = useRef<ImageBitmap | null>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    base: ViewTransform
    moved: boolean
  } | null>(null)
  const [dragging, setDragging] = useState(false)

  const entryKey = `${entryA.id}|${entryB.id}`

  // 卸载：释放 pin 与 diff bitmap
  useEffect(() => {
    return () => {
      for (const u of framePinsRef.current) u()
      framePinsRef.current = []
      diffBmpRef.current?.close()
      diffBmpRef.current = null
    }
  }, [])

  // A/B 解码（缓存命中同步取，未命中异步；期间保留旧帧）
  useLayoutEffect(() => {
    let disposed = false
    let consumed = false
    const unpins = [pinDecoded(entryA.id), pinDecoded(entryB.id)]
    const finish = (a: DecodedImage | null, b: DecodedImage | null) => {
      if (disposed || !a || !b) return
      consumed = true
      setDecoded({ a, b })
      onMeta?.(a.natural.w, a.natural.h)
      for (const u of framePinsRef.current) u()
      framePinsRef.current = unpins
    }
    const pa = peekDecoded(entryA.id)
    const pb = peekDecoded(entryB.id)
    if (pa && pb) finish(pa, pb)
    else void Promise.all([getDecoded(entryA), getDecoded(entryB)]).then(([a, b]) => finish(a, b))
    return () => {
      disposed = true
      if (!consumed) for (const u of unpins) u()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryKey])

  // 容器尺寸
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((es) => {
      const r = es[0].contentRect
      setContainerSize({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const meta = decoded ? decoded.a.natural : null
  const rotated90 = transform.rotation % 180 !== 0

  const fitZoom = useMemo(() => {
    if (!meta || containerSize.w === 0 || containerSize.h === 0) return 1
    const effW = rotated90 ? meta.h : meta.w
    const effH = rotated90 ? meta.w : meta.h
    return clamp(Math.min(containerSize.w / effW, containerSize.h / effH), MIN_ZOOM, MAX_ZOOM)
  }, [meta, containerSize, rotated90])

  const effZoom = transform.mode === 'fit' ? fitZoom : transform.zoom

  useEffect(() => {
    if (meta) onEffectiveZoom?.(effZoom)
  }, [effZoom, meta, onEffectiveZoom])

  // 差值重算：源图 / 容差 / colormap 变化才重算（防抖 100ms，滑块连拖不炸 CPU）
  useEffect(() => {
    if (!decoded?.a.bitmap || !decoded.b.bitmap) return
    const bmpA = decoded.a.bitmap
    const bmpB = decoded.b.bitmap
    setComputing(true)
    const timer = window.setTimeout(() => {
      void computeDiffBitmap(bmpA, bmpB, tolerance, colormap).then((bmp) => {
        diffBmpRef.current?.close()
        diffBmpRef.current = bmp
        setDiffBmp(bmp)
        setComputing(false)
      })
    }, 100)
    return () => clearTimeout(timer)
  }, [decoded, tolerance, colormap])

  // 绘制：transform 变化只重绘（drawImage 已算好的 diff bitmap），不重算
  const rw = meta ? meta.w * effZoom : 0
  const rh = meta ? meta.h * effZoom : 0
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !diffBmp || rw <= 0 || rh <= 0) return
    const cw = Math.min(Math.max(1, Math.round(rw)), 4096)
    const ch = Math.min(Math.max(1, Math.round(rh)), 4096)
    if (canvas.width !== cw) canvas.width = cw
    if (canvas.height !== ch) canvas.height = ch
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.clearRect(0, 0, cw, ch)
    ctx.drawImage(diffBmp, 0, 0, diffBmp.width, diffBmp.height, 0, 0, cw, ch)
  }, [diffBmp, rw, rh])

  // 滚轮缩放（以指针为锚）
  const onWheel = useCallback(
    (e: WheelEvent) => {
      if (!meta || !containerRef.current) return
      e.preventDefault()
      const rect = containerRef.current.getBoundingClientRect()
      const cx = e.clientX - rect.left - rect.width / 2
      const cy = e.clientY - rect.top - rect.height / 2
      const cur = transform.mode === 'fit' ? fitZoom : transform.zoom
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2
      const next = clamp(cur * factor, MIN_ZOOM, MAX_ZOOM)
      if (next === cur) return
      const rw0 = meta.w * cur
      const rh0 = meta.h * cur
      const px0 = transform.mode === 'fit' ? 0 : transform.panFX * rw0
      const py0 = transform.mode === 'fit' ? 0 : transform.panFY * rh0
      const left0 = -rw0 / 2 + px0
      const top0 = -rh0 / 2 + py0
      const u = (cx - left0) / rw0
      const v = (cy - top0) / rh0
      const rw1 = meta.w * next
      const rh1 = meta.h * next
      const nx = cx - u * rw1
      const ny = cy - v * rh1
      onTransformChange({
        ...transform,
        mode: 'free',
        zoom: next,
        panFX: (nx + rw1 / 2) / rw1,
        panFY: (ny + rh1 / 2) / rh1,
      })
    },
    [meta, transform, fitZoom, onTransformChange],
  )

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !meta) return
    const base: ViewTransform =
      transform.mode === 'fit' ? { ...transform, mode: 'free', zoom: fitZoom } : transform
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      base,
      moved: false,
    }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId || !meta) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return
    drag.moved = true
    const rw0 = meta.w * drag.base.zoom
    const rh0 = meta.h * drag.base.zoom
    onTransformChange({
      ...drag.base,
      mode: 'free',
      panFX: drag.base.panFX + dx / rw0,
      panFY: drag.base.panFY + dy / rh0,
    })
  }

  const endDrag = (e: React.PointerEvent) => {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null
      setDragging(false)
    }
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (e.altKey) return
    if (onToggleFullscreen) {
      onToggleFullscreen()
      return
    }
    if (transform.mode === 'fit') {
      onTransformChange({ ...transform, mode: 'free', zoom: 1, panFX: 0, panFY: 0 })
    } else {
      onTransformChange({ ...transform, mode: 'fit', panFX: 0, panFY: 0 })
    }
  }

  const px = transform.mode === 'fit' ? 0 : transform.panFX * rw
  const py = transform.mode === 'fit' ? 0 : transform.panFY * rh

  return (
    <div
      ref={containerRef}
      data-view-pane
      className={cn(
        'relative select-none overflow-hidden bg-[var(--tv-well)]',
        dragging ? 'cursor-grabbing' : 'cursor-grab',
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
    >
      <div
        className="pointer-events-none absolute left-1/2 top-1/2"
        style={{
          width: rw,
          height: rh,
          visibility: meta && diffBmp ? 'visible' : 'hidden',
          transform: `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${transform.rotation}deg)`,
        }}
      >
        <canvas ref={canvasRef} data-diff-canvas className="h-full w-full" aria-label="差值热图" />
      </div>
      {(!diffBmp || computing) && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--tv-text-faint)]">
          {computing ? '计算差值…' : '加载中…'}
        </div>
      )}
      <div className="pointer-events-none absolute left-2 top-2 whitespace-nowrap rounded bg-emerald-600 px-2 py-0.5 text-xs font-bold text-white shadow">
        DIFF
      </div>
      {title && (
        <div className="pointer-events-none absolute bottom-2 left-1/2 max-w-[90%] -translate-x-1/2 truncate rounded bg-black/60 px-2 py-0.5 text-xs text-neutral-200">
          {title}
        </div>
      )}
    </div>
  )
}
