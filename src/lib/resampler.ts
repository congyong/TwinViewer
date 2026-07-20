// 软件重采样：CPU 可分离两遍卷积，供 canvas 精确缩放（BIFant / 双线性 / 双立方 / Lanczos-3）。
// 现状浏览仍用 imageSmoothing 快速预览，停止操作 ~150ms 后由本模块精确重绘。

export type ResampleAlgo = 'bifant' | 'bilinear' | 'bicubic' | 'lanczos'

export function isPreciseAlgo(v: string): v is ResampleAlgo {
  return v === 'bifant' || v === 'bilinear' || v === 'bicubic' || v === 'lanczos'
}

// ---- 卷积核 ----
type Kernel = { support: number; fn: (x: number) => number; /** 真面积平均模式（权重=覆盖长度，不走 fn 采样） */ area?: boolean }
const KERNELS: Record<ResampleAlgo, Kernel> = {
  // BIFant：面积平均（盒式滤波），缩小最干净；权重按源像素被输出足迹的**覆盖长度**计算（真 Fant）
  bifant: { support: 0.5, area: true, fn: (x) => (Math.abs(x) <= 0.5 ? 1 : 0) },
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
    if (k.area) {
      // 真面积平均（Fant）：输出像素的源足迹 [center±support] 与源像素 [p, p+1] 的
      // 覆盖长度即权重——边缘像素按被覆盖比例部分计入，杜绝 all-or-nothing 造成的
      // 周期性横竖线（轻微缩小 ≥0.78 时足迹宽 1~1.3px，边缘全计入/全剔除会振荡；
      // 放大时还能避免中心距离 >0.5 被清零成全黑像素）
      const loF = center - support
      const hiF = center + support
      const lo = Math.max(0, Math.floor(loF))
      const hi = Math.min(srcLen - 1, Math.ceil(hiF) - 1)
      const n = hi - lo + 1
      const w = new Float32Array(n)
      let sum = 0
      for (let j = 0; j < n; j++) {
        const v = Math.max(0, Math.min(hiF, lo + j + 1) - Math.max(loF, lo + j))
        w[j] = v
        sum += v
      }
      if (sum > 0) for (let j = 0; j < n; j++) w[j] /= sum
      out[i] = { start: lo, weights: w }
      continue
    }
    // 贡献窗必须覆盖核支撑内的**像素中心**（像素 p 中心在 p+0.5）：
    // 窗取 [center-support-0.5, center+support+0.5]，多收的尾部像素权重自然为 0
    const lo = Math.max(0, Math.ceil(center - support - 0.5))
    const hi = Math.min(srcLen - 1, Math.floor(center + support + 0.5))
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

/** 水平遍行区间：sd(sw×sh RGBA) → mid(midW×sh Float32)，处理源行 [y0,y1) */
function hPassRange(
  sd: Uint8ClampedArray,
  sw: number,
  mid: Float32Array,
  midW: number,
  cx: Contrib[] | null,
  y0: number,
  y1: number,
): void {
  for (let y = y0; y < y1; y++) {
    const rowOff = y * sw * 4
    const outOff = y * midW * 4
    if (!cx) {
      for (let i = 0; i < sw * 4; i++) mid[outOff + i] = sd[rowOff + i]
      continue
    }
    for (let x = 0; x < midW; x++) {
      const c = cx[x]
      let r = 0, g = 0, b = 0, a = 0
      for (let j = 0; j < c.weights.length; j++) {
        const p = rowOff + (c.start + j) * 4
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
}

/** 垂直遍行区间：mid(midW×sh Float32) → dd(midW×outH Uint8)，处理输出行 [y0,y1) */
function vPassRange(
  mid: Float32Array,
  midW: number,
  dd: Uint8ClampedArray,
  cy: Contrib[] | null,
  y0: number,
  y1: number,
): void {
  for (let y = y0; y < y1; y++) {
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
}

/**
 * 纯像素重采样（无 DOM 依赖，供独立验证脚本/测试）：
 * 与 resampleTo 同一套 contribs + 两遍行区间卷积，同步执行，返回 RGBA 字节。
 */
export function resamplePixels(
  sd: Uint8ClampedArray,
  sw: number,
  sh: number,
  tw: number,
  th: number,
  algo: ResampleAlgo,
): Uint8ClampedArray {
  const kernel = KERNELS[algo]
  const needH = tw !== sw
  const needV = th !== sh
  const cx = needH ? contribs(sw, tw, kernel) : null
  const cy = needV ? contribs(sh, th, kernel) : null
  const midW = needH ? tw : sw
  const mid = new Float32Array(midW * sh * 4)
  hPassRange(sd, sw, mid, midW, cx, 0, sh)
  const outH = needV ? th : sh
  const dd = new Uint8ClampedArray(midW * outH * 4)
  vPassRange(mid, midW, dd, cy, 0, outH)
  return dd
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
        hPassRange(sd, sw, mid, midW, cx, y0, yEnd)
        if (yEnd < sh) await new Promise((r) => setTimeout(r, 0))
      }

      // 垂直：midW×sh → midW×th
      const dst = new ImageData(midW, needV ? th : sh)
      const dd = dst.data
      for (let y0 = 0; y0 < dst.height; y0 += ROW_CHUNK) {
        if (cancelled) return onDone(null)
        const yEnd = Math.min(dst.height, y0 + ROW_CHUNK)
        vPassRange(mid, midW, dd, cy, y0, yEnd)
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
