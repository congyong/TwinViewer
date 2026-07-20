/**
 * 通用图像查看窗格：
 * - 图层渲染（wipe 裁剪 / overlay 透明度）、fit/自由缩放、拖拽平移（位移存为渲染尺寸分数）、
 *   滚轮锚点缩放、双击（全屏切换 或 适应↔100%）、R/L 旋转（transform.rotation 角度制）
 * - 重采样：邻近/自动走 <img>（imageRendering 控制），BIFant/双线性/双立方/Lanczos 走 Canvas
 *   （平滑预览 + resampler.ts 软件精确重采样，停手 ~150ms 后精确重绘）
 * - 解码统一走会话缓存（decode-cache），显示层与分析层（直方图/EXIF/探针）共享同一份 bitmap
 * - **双缓冲无缝切图**：新图未就绪前保留旧帧（不清空、不卸载旧图层），就绪后原子交换；
 *   缓存命中时经 peekDecoded 同步取帧（layout effect 内当帧渲染，无 await 间隙、无黑帧）；
 *   切图且命中时 Canvas 立即绘制（跳过 120ms 防抖，防抖只留给连续缩放重采样）
 * - 在显帧始终持有 pin（pinDecoded），过渡期新旧帧同时受保护，绝不被 LRU 淘汰
 * - ALT 颜色探针：按住 ALT 显示原图坐标 + RGB 浮签（经当前 transform 逆映射，含旋转），
 *   ALT+单击取样到侧栏「取样记录」（拦截该点击，不触发平移/激活/双击）
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ImageEntry } from '@/lib/fs-provider'
import { clamp } from '@/lib/format'
import type { ViewTransform } from '@/store/appStore'
import { useAppStore } from '@/store/appStore'
import { getDecoded, peekDecoded, pinDecoded, type DecodedImage } from '@/lib/decode-cache'
import { probePixel, type PixelRGBA } from '@/lib/pixel-probe'
import { isPreciseAlgo, resampleTo, type ResampleAlgo, type ResampleHandle } from '@/lib/resampler'
import { cn } from '@/lib/utils'

const MIN_ZOOM = 0.02
const MAX_ZOOM = 64

/**
 * 双线性/双立方/BIFant/Lanczos 的 Canvas 平滑绘制。
 * 防抖策略：**图像源（bitmap/img）变化 = 立即绘制**（切图无等待，layout effect 内同步上屏）；
 * 仅尺寸/质量变化（连续缩放）才 120ms 防抖，停手后出清图。
 * 软件重采样：快速平滑绘制作为预览，停手 ~150ms 后用 resampler 精确重绘（可取消、LRU 缓存）。
 */
function CanvasSmooth({
  bitmap,
  url,
  rw,
  rh,
  quality,
  algo,
  cacheKey,
  alt,
}: {
  bitmap: ImageBitmap | null
  url: string
  rw: number
  rh: number
  quality: 'low' | 'high'
  /** 软件重采样算法（null = 仅平滑预览） */
  algo: ResampleAlgo | null
  /** 重采样缓存键（通常条目 id） */
  cacheKey: string
  alt: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const preciseRef = useRef<ResampleHandle | null>(null)
  const preciseTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (bitmap) return
    let cancelled = false
    const el = new Image()
    el.onload = () => {
      if (!cancelled) setImg(el)
    }
    el.src = url
    return () => {
      cancelled = true
    }
  }, [bitmap, url])

  const source = bitmap ?? img
  const prevSourceRef = useRef<ImageBitmap | HTMLImageElement | null>(null)

  // 卸载时取消未完成的精确重采样
  useEffect(() => {
    return () => {
      preciseRef.current?.cancel()
      if (preciseTimerRef.current !== null) clearTimeout(preciseTimerRef.current)
    }
  }, [])

  useLayoutEffect(() => {
    if (!source || rw <= 0 || rh <= 0) return
    const immediate = prevSourceRef.current !== source
    prevSourceRef.current = source
    const cw = Math.min(Math.max(1, Math.round(rw)), 4096)
    const ch = Math.min(Math.max(1, Math.round(rh)), 4096)
    const draw = () => {
      const canvas = ref.current
      if (!canvas) return
      if (canvas.width !== cw) canvas.width = cw
      if (canvas.height !== ch) canvas.height = ch
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = quality
      ctx.clearRect(0, 0, cw, ch)
      const sw = bitmap ? bitmap.width : (source as HTMLImageElement).naturalWidth
      const sh = bitmap ? bitmap.height : (source as HTMLImageElement).naturalHeight
      ctx.drawImage(source, 0, 0, sw, sh, 0, 0, cw, ch)
    }
    /** 停手后精确重采样：先取消旧任务，150ms 防抖 */
    const schedulePrecise = () => {
      preciseRef.current?.cancel()
      preciseRef.current = null
      if (preciseTimerRef.current !== null) {
        clearTimeout(preciseTimerRef.current)
        preciseTimerRef.current = null
      }
      if (!algo || !bitmap) return
      preciseTimerRef.current = window.setTimeout(() => {
        preciseTimerRef.current = null
        preciseRef.current = resampleTo(bitmap, `${cacheKey}|${algo}|${cw}x${ch}`, cw, ch, algo, (bmp) => {
          preciseRef.current = null
          if (!bmp) return
          const canvas = ref.current
          if (!canvas) return
          const ctx = canvas.getContext('2d')
          if (!ctx) return
          ctx.imageSmoothingEnabled = false
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          ctx.drawImage(bmp, 0, 0)
        })
      }, 150)
    }
    if (immediate) {
      draw() // 切图/新源：当帧同步绘制（pre-paint），无黑帧
      schedulePrecise()
      return
    }
    const timer = setTimeout(() => {
      draw()
      schedulePrecise()
    }, 120) // 连续缩放：防抖重绘
    return () => clearTimeout(timer)
  }, [source, bitmap, rw, rh, quality, algo, cacheKey])

  return <canvas ref={ref} className="h-full w-full" aria-label={alt} />
}

export interface LayerSpec {
  entry: ImageEntry
  /** 叠化顶层不透明度（0-1） */
  opacity?: number
  /** 额外 CSS clip-path（wipe 顶层裁剪由 wipe 参数接管） */
  clipPath?: string
  onMeta?: (w: number, h: number) => void
}

interface ViewerPaneProps {
  layers: LayerSpec[]
  transform: ViewTransform
  onTransformChange: (t: ViewTransform) => void
  label?: string
  labelColor?: string
  title?: string
  active?: boolean
  onActivate?: () => void
  onMeta?: (w: number, h: number) => void
  onEffectiveZoom?: (z: number) => void
  wipe?: { ratio: number; onChange: (r: number) => void }
  onToggleFullscreen?: () => void
  className?: string
  /** ALT 取样记录的槽位标签（默认 '—'） */
  probeSlot?: string
  /** ALT 探针取样的图层索引（默认 0） */
  probeLayer?: number
}

/** 一帧完整画面：图层定义 + 解码产物 + 自然尺寸（原子交换的最小单位） */
interface Frame {
  key: string
  layers: LayerSpec[]
  decoded: (DecodedImage | null)[]
  metas: ({ w: number; h: number } | null)[]
}

export function ViewerPane({
  layers,
  transform,
  onTransformChange,
  label,
  labelColor = 'bg-sky-600',
  title,
  active,
  onActivate,
  onMeta,
  onEffectiveZoom,
  wipe,
  onToggleFullscreen,
  className,
  probeSlot = '—',
  probeLayer = 0,
}: ViewerPaneProps) {
  const resample = useAppStore((s) => s.resample)
  const addSample = useAppStore((s) => s.addSample)
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 })
  // 双缓冲：frame 为当前上屏帧；切图时保留旧帧直到新帧就绪
  const [frame, setFrame] = useState<Frame | null>(null)
  /** 当前上屏帧持有的 unpin 函数（过渡期内旧帧 pin 与新帧 pin 同时存活） */
  const framePinsRef = useRef<(() => void)[]>([])
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    base: ViewTransform
    moved: boolean
  } | null>(null)
  const wipeDragRef = useRef<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [altDown, setAltDown] = useState(false)
  const [probe, setProbe] = useState<{
    mx: number
    my: number
    x: number
    y: number
    cw: number
    ch: number
    rgba: PixelRGBA | null
  } | null>(null)
  const probeReqRef = useRef(0)

  const layerKey = useMemo(() => layers.map((l) => l.entry.id).join('|'), [layers])

  // 卸载时释放当前帧的 pin
  useEffect(() => {
    return () => {
      for (const u of framePinsRef.current) u()
      framePinsRef.current = []
    }
  }, [])

  /**
   * 图层解码（双缓冲交换）：
   * - 缓存全部命中 → peekDecoded 同步 finish（layout effect 内当帧上屏）
   * - 否则异步解码，期间旧帧保留（不黑屏）；就绪后原子交换并释放旧帧 pin
   */
  useLayoutEffect(() => {
    let disposed = false
    let consumed = false
    const unpins = layers.map((l) => pinDecoded(l.entry.id))
    setProbe(null)
    const finish = (decoded: (DecodedImage | null)[]) => {
      if (disposed) return
      consumed = true
      const metas = decoded.map((d) => (d ? { w: d.natural.w, h: d.natural.h } : null))
      setFrame({ key: layerKey, layers, decoded, metas })
      // 新帧已上屏：释放旧帧 pin，新帧 pin 转交 framePinsRef 持有
      for (const u of framePinsRef.current) u()
      framePinsRef.current = unpins
      metas.forEach((m, i) => {
        if (!m) return
        if (i === 0) onMeta?.(m.w, m.h)
        layers[i]?.onMeta?.(m.w, m.h)
      })
    }
    const peeked = layers.map((l) => peekDecoded(l.entry.id))
    if (layers.length > 0 && peeked.every((d) => d !== null)) {
      finish(peeked)
    } else {
      void Promise.all(layers.map((l) => getDecoded(l.entry))).then(finish)
    }
    return () => {
      disposed = true
      // 未完成交换即被取代/卸载：本 effect 自己持有的 pin 自行释放
      if (!consumed) for (const u of unpins) u()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerKey])

  // 容器尺寸
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setContainerSize({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ALT 键跟踪（按住进入探针模式）
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        e.preventDefault()
        setAltDown(true)
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        setAltDown(false)
        setProbe(null)
      }
    }
    const blur = () => {
      setAltDown(false)
      setProbe(null)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  // 上屏帧选取：layerKey 未变时用 props layers（叠化透明度等实时生效）；切换中保留旧帧
  const stale = frame !== null && frame.key !== layerKey
  const shownLayers = frame === null ? [] : stale ? frame.layers : layers
  const shownDecoded = frame?.decoded ?? []
  const shownMetas = frame?.metas ?? []
  const primaryMeta = shownMetas[0] ?? null
  const rotated90 = transform.rotation % 180 !== 0

  // fit 缩放：旋转 90/270 时按交换后的宽高适应；夹取 [MIN_ZOOM, MAX_ZOOM]
  const fitZoom = useMemo(() => {
    if (!primaryMeta || containerSize.w === 0 || containerSize.h === 0) return 1
    const effW = rotated90 ? primaryMeta.h : primaryMeta.w
    const effH = rotated90 ? primaryMeta.w : primaryMeta.h
    return clamp(Math.min(containerSize.w / effW, containerSize.h / effH), MIN_ZOOM, MAX_ZOOM)
  }, [primaryMeta, containerSize, rotated90])

  const effZoom = transform.mode === 'fit' ? fitZoom : transform.zoom

  /** 图层几何：渲染尺寸 rw/rh 与中心位移（fit 模式无位移；free 按渲染尺寸分数） */
  const layerGeom = useCallback(
    (idx: number) => {
      const meta = shownMetas[idx] ?? null
      const rw = meta ? meta.w * effZoom : 0
      const rh = meta ? meta.h * effZoom : 0
      const px = transform.mode === 'fit' ? 0 : transform.panFX * rw
      const py = transform.mode === 'fit' ? 0 : transform.panFY * rh
      return { rw, rh, px, py }
    },
    [shownMetas, effZoom, transform.mode, transform.panFX, transform.panFY],
  )

  // 有效缩放变化上报（状态栏/信息浮层）
  useEffect(() => {
    if (primaryMeta) onEffectiveZoom?.(effZoom)
  }, [effZoom, primaryMeta, onEffectiveZoom])

  // 滚轮缩放（以指针为锚，保持指针下图像点不动）
  const onWheel = useCallback(
    (e: WheelEvent) => {
      if (!primaryMeta || !containerRef.current) return
      e.preventDefault()
      const rect = containerRef.current.getBoundingClientRect()
      const cx = e.clientX - rect.left - rect.width / 2
      const cy = e.clientY - rect.top - rect.height / 2
      const cur = transform.mode === 'fit' ? fitZoom : transform.zoom
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2
      const next = clamp(cur * factor, MIN_ZOOM, MAX_ZOOM)
      if (next === cur) return
      const rw0 = primaryMeta.w * cur
      const rh0 = primaryMeta.h * cur
      const px0 = transform.mode === 'fit' ? 0 : transform.panFX * rw0
      const py0 = transform.mode === 'fit' ? 0 : transform.panFY * rh0
      const left0 = -rw0 / 2 + px0
      const top0 = -rh0 / 2 + py0
      const u = (cx - left0) / rw0
      const v = (cy - top0) / rh0
      const rw1 = primaryMeta.w * next
      const rh1 = primaryMeta.h * next
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
    [primaryMeta, transform, fitZoom, onTransformChange],
  )

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])

  /** 探针坐标换算：容器坐标 → 原图像素坐标（减中心+位移 → 按 -rotation 反旋 → 归一化 → ×原图尺寸） */
  const computeProbe = (clientX: number, clientY: number) => {
    const el = containerRef.current
    const meta = shownMetas[probeLayer]
    if (!el || !meta) return null
    const rect = el.getBoundingClientRect()
    const mx = clientX - rect.left
    const my = clientY - rect.top
    const g = layerGeom(probeLayer)
    if (g.rw <= 0 || g.rh <= 0) return null
    const dx = mx - rect.width / 2 - g.px
    const dy = my - rect.height / 2 - g.py
    const rad = (-transform.rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const rx = dx * cos - dy * sin
    const ry = dx * sin + dy * cos
    const u = rx / g.rw + 0.5
    const v = ry / g.rh + 0.5
    const inside = u >= 0 && u <= 1 && v >= 0 && v <= 1
    const x = Math.min(meta.w - 1, Math.max(0, Math.floor(u * meta.w)))
    const y = Math.min(meta.h - 1, Math.max(0, Math.floor(v * meta.h)))
    return { mx, my, x, y, cw: rect.width, ch: rect.height, inside }
  }

  /** 更新探针浮签（请求序号防过期） */
  const updateProbe = (clientX: number, clientY: number) => {
    const p = computeProbe(clientX, clientY)
    const layer = shownLayers[probeLayer]
    if (!p || !p.inside || !layer) {
      setProbe(null)
      return
    }
    const req = ++probeReqRef.current
    void probePixel(layer.entry, p.x, p.y).then((rgba) => {
      if (probeReqRef.current !== req) return
      setProbe({ mx: p.mx, my: p.my, x: p.x, y: p.y, cw: p.cw, ch: p.ch, rgba })
    })
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !primaryMeta) return
    // ALT+单击：取样当前图层该点颜色并记录到侧栏（拦截：不进入拖拽/激活逻辑）
    if (e.altKey) {
      e.preventDefault()
      const p = computeProbe(e.clientX, e.clientY)
      const layer = shownLayers[probeLayer]
      if (p?.inside && layer) {
        void probePixel(layer.entry, p.x, p.y).then((rgba) => {
          if (rgba) {
            addSample({ slot: probeSlot, name: layer.entry.name, x: p.x, y: p.y, ...rgba })
          }
        })
      }
      return
    }
    onActivate?.()
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
    if (altDown) updateProbe(e.clientX, e.clientY)
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId || !primaryMeta) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return
    drag.moved = true
    const rw = primaryMeta.w * drag.base.zoom
    const rh = primaryMeta.h * drag.base.zoom
    onTransformChange({
      ...drag.base,
      mode: 'free',
      panFX: drag.base.panFX + dx / rw,
      panFY: drag.base.panFY + dy / rh,
    })
  }

  const endDrag = (e: React.PointerEvent) => {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null
      setDragging(false)
    }
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (e.altKey) return // ALT 双击视同两次取样，不触发缩放/全屏切换
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

  // wipe 分割线位置（相对容器左边界的 x 像素）
  const WIPE_LAYER = 1
  let wipeX: number | null = null
  if (wipe && shownMetas[WIPE_LAYER] && containerSize.w > 0) {
    const g = layerGeom(WIPE_LAYER)
    if (g.rw > 0) wipeX = containerSize.w / 2 - g.rw / 2 + g.px + wipe.ratio * g.rw
  }

  const onWipeDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    wipeDragRef.current = e.pointerId
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onWipeMove = (e: React.PointerEvent) => {
    if (wipeDragRef.current !== e.pointerId || !wipe || !containerRef.current) return
    e.stopPropagation()
    const rect = containerRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const g = layerGeom(WIPE_LAYER)
    if (g.rw <= 0) return
    const left = rect.width / 2 - g.rw / 2 + g.px
    wipe.onChange(clamp((x - left) / g.rw, 0.02, 0.98))
  }
  const onWipeUp = (e: React.PointerEvent) => {
    if (wipeDragRef.current === e.pointerId) wipeDragRef.current = null
  }

  const useCanvas = isPreciseAlgo(resample)
  const canvasQuality = resample === 'bilinear' ? ('low' as const) : ('high' as const)

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative select-none overflow-hidden bg-[var(--tv-well)]',
        active && 'ring-2 ring-inset ring-sky-500',
        altDown ? 'cursor-crosshair' : dragging ? 'cursor-grabbing' : 'cursor-grab',
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => {
        if (!dragRef.current) setProbe(null)
      }}
      onDoubleClick={onDoubleClick}
    >
      {shownLayers.map((layer, i) => {
        const g = layerGeom(i)
        const meta = shownMetas[i]
        const decoded = shownDecoded[i]
        const clip = wipe && i === WIPE_LAYER ? `inset(0 0 0 ${wipe.ratio * 100}%)` : layer.clipPath
        if (!decoded) return null
        return (
          <div
            key={layer.entry.id}
            className="pointer-events-none absolute left-1/2 top-1/2"
            style={{
              width: meta ? g.rw : 0,
              height: meta ? g.rh : 0,
              visibility: meta ? 'visible' : 'hidden',
              opacity: layer.opacity ?? 1,
              clipPath: clip,
              transform: `translate(calc(-50% + ${g.px}px), calc(-50% + ${g.py}px)) rotate(${transform.rotation}deg)`,
            }}
          >
            {useCanvas ? (
              <CanvasSmooth
                bitmap={decoded.bitmap}
                url={decoded.url}
                rw={meta ? g.rw : 0}
                rh={meta ? g.rh : 0}
                quality={canvasQuality}
                algo={isPreciseAlgo(resample) ? resample : null}
                cacheKey={layer.entry.id}
                alt={layer.entry.name}
              />
            ) : (
              <img
                src={decoded.url}
                alt={layer.entry.name}
                draggable={false}
                className="h-full w-full"
                style={{ imageRendering: resample === 'nearest' || effZoom > 4 ? 'pixelated' : 'auto' }}
              />
            )}
          </div>
        )
      })}
      {/* 黑背景/加载提示仅在真正无图时出现（双缓冲期间旧帧始终上屏） */}
      {!primaryMeta && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--tv-text-faint)]">加载中…</div>
      )}
      {label && (
        <div
          className={cn(
            'pointer-events-none absolute left-2 top-2 rounded px-2 py-0.5 text-xs font-bold text-white shadow',
            labelColor,
          )}
        >
          {label}
        </div>
      )}
      {title && (
        <div className="pointer-events-none absolute bottom-2 left-1/2 max-w-[90%] -translate-x-1/2 truncate rounded bg-black/60 px-2 py-0.5 text-xs text-neutral-200">
          {title}
        </div>
      )}
      {wipe && wipeX !== null && (
        <div className="absolute inset-y-0 z-10" style={{ left: wipeX }}>
          <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white/85 shadow-[0_0_4px_rgba(0,0,0,0.9)]" />
          <div
            className="absolute top-1/2 flex h-12 w-5 -translate-x-1/2 -translate-y-1/2 cursor-col-resize items-center justify-center rounded border border-black/30 bg-white/90 text-[10px] font-bold tracking-tighter text-neutral-700 shadow-md hover:bg-white"
            title="左右拖动对比线"
            onPointerDown={onWipeDown}
            onPointerMove={onWipeMove}
            onPointerUp={onWipeUp}
            onPointerCancel={onWipeUp}
          >
            ⋮⋮
          </div>
        </div>
      )}
      {/* ALT 探针浮签：原图坐标 + RGB 色值 */}
      {altDown && probe && (
        <div
          className="pointer-events-none absolute z-30 flex items-center gap-1.5 rounded bg-black/85 px-1.5 py-0.5 font-mono text-[10px] text-neutral-200"
          style={{
            left: Math.min(probe.mx + 14, Math.max(0, probe.cw - 150)),
            top: Math.min(probe.my + 14, Math.max(0, probe.ch - 34)),
          }}
        >
          <span>
            {probe.x}, {probe.y}
          </span>
          {probe.rgba ? (
            <>
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm border border-white/30"
                style={{ backgroundColor: `rgb(${probe.rgba.r},${probe.rgba.g},${probe.rgba.b})` }}
              />
              <span>
                R:{probe.rgba.r} G:{probe.rgba.g} B:{probe.rgba.b}
                {probe.rgba.a < 255 ? ` A:${probe.rgba.a}` : ''}
              </span>
            </>
          ) : (
            <span className="text-neutral-500">读取中…</span>
          )}
        </div>
      )}
    </div>
  )
}
