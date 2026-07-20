/**
 * ALT 颜色探针的像素读取：
 * - 数据源 = 会话解码缓存的 bitmap（blob 解码，canvas 不污染；探针本身不触发新解码——
 *   只有首次显示该图时解码过，之后探针复用同一 bitmap 一次性绘制到离屏 canvas）
 * - 每张图绘制一次到离屏 canvas（最长边 ≤4096 限制内存，取样坐标按比例换算），
 *   getImageData 单点取值；canvas 按 entry.id 缓存（LRU 上限 4 张）
 * - twinview:// 兜底路径（无 blob）会因 canvas 污染取不到值，返回 null（Electron 正常路径均为 blob）
 */
import type { ImageEntry } from './fs-provider'
import { getDecoded } from './decode-cache'

/** 离屏 canvas 最长边上限（内存保护：4096×4096×4 ≈ 67MB/张 上限） */
const MAX_EDGE = 4096
/** 离屏 canvas 缓存上限（LRU） */
const MAX_CANVAS_CACHE = 4

interface ProbeCanvas {
  canvas: HTMLCanvasElement
  /** 离屏尺寸 / 原图尺寸 */
  scale: number
  last: number
}

const canvasCache = new Map<string, ProbeCanvas>()

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
}

async function getProbeCanvas(entry: ImageEntry): Promise<ProbeCanvas | null> {
  const hit = canvasCache.get(entry.id)
  if (hit) {
    hit.last = Date.now()
    return hit
  }
  const dec = await getDecoded(entry)
  if (!dec) return null
  const scale = Math.min(1, MAX_EDGE / Math.max(dec.natural.w, dec.natural.h))
  const w = Math.max(1, Math.round(dec.natural.w * scale))
  const h = Math.max(1, Math.round(dec.natural.h * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  const source = dec.bitmap ?? (await loadImage(dec.url))
  ctx.drawImage(source, 0, 0, w, h)
  const rec: ProbeCanvas = { canvas, scale, last: Date.now() }
  canvasCache.set(entry.id, rec)
  // LRU 淘汰最久未用
  while (canvasCache.size > MAX_CANVAS_CACHE) {
    let victim: string | null = null
    let oldest = Infinity
    for (const [k, v] of canvasCache) {
      if (v.last < oldest) {
        oldest = v.last
        victim = k
      }
    }
    if (victim === null) break
    canvasCache.delete(victim)
  }
  return rec
}

export interface PixelRGBA {
  r: number
  g: number
  b: number
  a: number
}

/** 取原图坐标 (x, y) 处的 RGBA；图外/不可读返回 null */
export async function probePixel(entry: ImageEntry, x: number, y: number): Promise<PixelRGBA | null> {
  try {
    const rec = await getProbeCanvas(entry)
    if (!rec) return null
    const sx = Math.min(rec.canvas.width - 1, Math.max(0, Math.round(x * rec.scale)))
    const sy = Math.min(rec.canvas.height - 1, Math.max(0, Math.round(y * rec.scale)))
    const ctx = rec.canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    const d = ctx.getImageData(sx, sy, 1, 1).data
    return { r: d[0], g: d[1], b: d[2], a: d[3] }
  } catch {
    return null
  }
}

/** 清空探针 canvas 缓存（随会话边界调用） */
export function clearProbeCache(): void {
  canvasCache.clear()
}
