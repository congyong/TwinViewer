// 软件重采样：CPU 可分离两遍卷积，供 canvas 精确缩放（BIFant / 双线性 / 双立方 / Lanczos-3）。
// 现状浏览仍用 imageSmoothing 快速预览，停止操作 ~150ms 后由本模块精确重绘。

export type ResampleAlgo = 'bifant' | 'bilinear' | 'bicubic' | 'lanczos'

export function isPreciseAlgo(v: string): v is ResampleAlgo {
  return v === 'bifant' || v === 'bilinear' || v === 'bicubic' || v === 'lanczos'
}

// ---- 卷积核 ----
type Kernel = { support: number; fn: (x: number) => number }
const KERNELS: Record<ResampleAlgo, Kernel> = {
  // BIFant：面积平均（盒式滤波），缩小最干净
  bifant: { support: 0.5, fn: (x) => (Math.abs(x) <= 0.5 ? 1 : 0) },
  bilinear: { support: 1, fn: (x) => Math.max(0, 1 - Math.abs(x)) },
  // Catmull-Rom (a=-0.5)
  bicubic: {
    support: 2,
    fn: (x) => {
      const a = Math.abs(x)
      if (a <= 1) return 1.5 * a * a * a - 2.5 * a * a + 1
      if (a < 2) return -0.5 * a * a * a + 2.5 * a * a - 4 * a + 2
      return 0
    },
  },
  lanczos: {
    support: 3,
    fn: (x) => {
      const a = Math.abs(x)
      if (a >= 3) return 0
      if (a === 0) return 1
      const p = Math.PI * a
      return (3 * Math.sin(p) * Math.sin(p / 3)) / (p * p)
    },
  },
}

interface Contrib { start: number; weights: Float32Array }

/** 为一维方向预计算每个输出像素的贡献权重（缩小时按 1/scale 加宽核） */
function contribs(srcLen: number, dstLen: number, k: Kernel): Contrib[] {
  const scale = dstLen / srcLen
  const widen = scale < 1 ? 1 / scale : 1
  const support = k.support * widen
  const out: Contrib[] = new Array(dstLen)
  for (let i = 0; i < dstLen; i++) {
    const center = (i + 0.5) / scale
    const lo = Math.max(0, Math.ceil(center - support))
    const hi = Math.min(srcLen - 1, Math.floor(center + support))
    const n = hi - lo + 1
    const w = new Float32Array(n)
    let sum = 0
    for (let j = 0; j < n; j++) {
      const d = (lo + j + 0.5 - center) * (scale < 1 ? scale : 1)
      const v = k.fn(d)
      w[j] = v
      sum += v
    }
    if (sum !== 0) for (let j = 0; j < n; j++) w[j] /= sum
    out[i] = { start: lo, weights: w }
  }
  return out
}

// ---- LRU 缓存（按 条目|算法|目标尺寸 记忆结果） ----
const CACHE_MAX = 8
const cache = new Map<string, ImageBitmap>()
function cacheGet(key: string): ImageBitmap | null {
  const v = cache.get(key)
  if (!v) return null
  cache.delete(key)
  cache.set(key, v) // touch
  return v
}
function cacheSet(key: string, v: ImageBitmap) {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, v)
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.get(oldest)?.close()
    cache.delete(oldest)
  }
}
export function clearResampleCache() {
  for (const v of cache.values()) v.close()
  cache.clear()
}

export interface ResampleHandle { cancel: () => void }

/**
 * 将 source 重采样到 tw×th，完成后 onDone(bitmap)；取消或出错 onDone(null)。
 * 分片执行（setTimeout 让出主线程），返回可取消句柄。
 */
export function resampleTo(
  source: ImageBitmap,
  cacheKey: string,
  tw: number,
  th: number,
  algo: ResampleAlgo,
  onDone: (bmp: ImageBitmap | null) => void,
): ResampleHandle {
  const hit = cacheGet(cacheKey)
  if (hit) {
    onDone(hit)
    return { cancel: () => {} }
  }
  let cancelled = false
  const run = async () => {
    try {
      const sw = source.width
      const sh = source.height
      if (!sw || !sh || !tw || !th) return onDone(null)
      const srcCanvas = document.createElement('canvas')
      srcCanvas.width = sw
      srcCanvas.height = sh
      const sctx = srcCanvas.getContext('2d')
      if (!sctx) return onDone(null)
      sctx.drawImage(source, 0, 0)
      const src = sctx.getImageData(0, 0, sw, sh)
      if (cancelled) return onDone(null)

      const kernel = KERNELS[algo]
      const needH = tw !== sw
      const needV = th !== sh
      const cx = needH ? contribs(sw, tw, kernel) : null
      const cy = needV ? contribs(sh, th, kernel) : null

      // 水平：sw×sh → tw×sh
      const midW = needH ? tw : sw
      const mid = new Float32Array(midW * sh * 4)
      const sd = src.data
      const ROW_CHUNK = 256
      for (let y0 = 0; y0 < sh; y0 += ROW_CHUNK) {
        if (cancelled) return onDone(null)
        const yEnd = Math.min(sh, y0 + ROW_CHUNK)
        for (let y = y0; y < yEnd; y++) {
          const rowOff = y * sw * 4
          const outOff = y * midW * 4
          if (!cx) {
            for (let i = 0; i < sw * 4; i++) mid[outOff + i] = sd[rowOff + i]
            continue
          }
          for (let x = 0; x < tw; x++) {
            const c = cx[x]
            let r = 0, g = 0, b = 0, a = 0
            for (let j = 0; j < c.weights.length; j++) {
              const p = (rowOff + (c.start + j) * 4)
              const w = c.weights[j]
              r += sd[p] * w
              g += sd[p + 1] * w
              b += sd[p + 2] * w
              a += sd[p + 3] * w
            }
            const o = outOff + x * 4
            mid[o] = r; mid[o + 1] = g; mid[o + 2] = b; mid[o + 3] = a
          }
        }
        if (yEnd < sh) await new Promise((r) => setTimeout(r, 0))
      }

      // 垂直：midW×sh → midW×th
      const dst = new ImageData(midW, needV ? th : sh)
      const dd = dst.data
      for (let y0 = 0; y0 < dst.height; y0 += ROW_CHUNK) {
        if (cancelled) return onDone(null)
        const yEnd = Math.min(dst.height, y0 + ROW_CHUNK)
        for (let y = y0; y < yEnd; y++) {
          const outOff = y * midW * 4
          if (!cy) {
            const srcOff = y * midW * 4
            for (let i = 0; i < midW * 4; i++) dd[outOff + i] = mid[srcOff + i]
            continue
          }
          const c = cy[y]
          for (let x = 0; x < midW; x++) {
            let r = 0, g = 0, b = 0, a = 0
            for (let j = 0; j < c.weights.length; j++) {
              const p = ((c.start + j) * midW + x) * 4
              const w = c.weights[j]
              r += mid[p] * w
              g += mid[p + 1] * w
              b += mid[p + 2] * w
              a += mid[p + 3] * w
            }
            const o = outOff + x * 4
            dd[o] = r; dd[o + 1] = g; dd[o + 2] = b; dd[o + 3] = a
          }
        }
        if (yEnd < dst.height) await new Promise((r) => setTimeout(r, 0))
      }
      if (cancelled) return onDone(null)

      const outCanvas = document.createElement('canvas')
      outCanvas.width = dst.width
      outCanvas.height = dst.height
      const octx = outCanvas.getContext('2d')
      if (!octx) return onDone(null)
      octx.putImageData(dst, 0, 0)
      const bmp = await createImageBitmap(outCanvas)
      if (cancelled) {
        bmp.close()
        return onDone(null)
      }
      cacheSet(cacheKey, bmp)
      onDone(bmp)
    } catch {
      onDone(null)
    }
  }
  void run()
  return { cancel: () => { cancelled = true } }
}
