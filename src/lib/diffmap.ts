/**
 * A/B 差值热图（diff 布局）：
 * - 公共采样网格 = A 的自然尺寸，B 经 canvas 平滑缩放到 A 尺寸（双线性近似，视觉正确且实现简单）
 * - 逐像素差值 = 三通道最大 abs diff（max(|Δr|,|Δg|,|Δb|)，取最大而非欧氏距离：对通道级错位更敏感、计算更省）
 * - ≤容差的像素置 0（黑色）；其余默认**直方图均衡**：>容差的幅值按 CDF 累积分布重映射到 0–1 全区间再过
 *   colormap LUT（两图很接近时小差异被拉伸可见）；关闭均衡回到 (diff-容差)/(255-容差) 线性归一
 * - 全黑（无 >容差像素）时跳过均衡（无映射对象亦避免除零）；stats 出参回报全局 diff 最大值（面板显示用）
 * - colormap：inferno / viridis 为标准 colormap 的锚点分段线性插值近似（256 级，视觉与原 LUT 一致）；
 *   gray 线性；coolwarm 发散（(59,76,192)→(221,221,221)→(180,4,38)，中点浅、两端深蓝深红）
 * - 输入 bitmap 来自 decode-cache（blob 解码，canvas 不污染）；计算结果由调用方缓存，
 *   缩放/平移不重算，源图/容差/colormap/均衡 变化才重算
 */
import type { DiffColormap } from '@/lib/settings'

type RGB = [number, number, number]

/** viridis 锚点（matplotlib 采样） */
const VIRIDIS_STOPS: RGB[] = [
  [68, 1, 84],
  [72, 35, 116],
  [64, 67, 135],
  [52, 94, 141],
  [41, 120, 142],
  [32, 144, 140],
  [34, 167, 133],
  [68, 190, 112],
  [121, 209, 81],
  [189, 223, 38],
  [253, 231, 37],
]

/** inferno 锚点（matplotlib 采样） */
const INFERNO_STOPS: RGB[] = [
  [0, 0, 4],
  [22, 11, 57],
  [66, 10, 104],
  [106, 23, 110],
  [147, 38, 103],
  [188, 55, 84],
  [221, 81, 58],
  [245, 116, 25],
  [252, 165, 10],
  [246, 215, 70],
  [252, 255, 164],
]

/** coolwarm 发散锚点（深蓝 → 浅中 → 深红） */
const COOLWARM_STOPS: RGB[] = [
  [59, 76, 192],
  [221, 221, 221],
  [180, 4, 38],
]

/** 锚点分段线性插值生成 256×3 LUT（Uint8ClampedArray，RGB 连续） */
function buildLut(stops: RGB[]): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3)
  const segs = stops.length - 1
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * segs
    const seg = Math.min(segs - 1, Math.floor(t))
    const f = t - seg
    const a = stops[seg]
    const b = stops[seg + 1]
    lut[i * 3] = a[0] + (b[0] - a[0]) * f
    lut[i * 3 + 1] = a[1] + (b[1] - a[1]) * f
    lut[i * 3 + 2] = a[2] + (b[2] - a[2]) * f
  }
  return lut
}

function buildGrayLut(): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3)
  for (let i = 0; i < 256; i++) {
    lut[i * 3] = i
    lut[i * 3 + 1] = i
    lut[i * 3 + 2] = i
  }
  return lut
}

const luts: Record<DiffColormap, Uint8ClampedArray> = {
  inferno: buildLut(INFERNO_STOPS),
  viridis: buildLut(VIRIDIS_STOPS),
  coolwarm: buildLut(COOLWARM_STOPS),
  gray: buildGrayLut(),
}

export function getDiffLut(map: DiffColormap): Uint8ClampedArray {
  return luts[map]
}

/** bitmap 绘制到指定尺寸的 ImageData（B 会平滑缩放到目标尺寸） */
function toImageData(src: ImageBitmap, w: number, h: number): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('canvas 2d 不可用')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h)
}

/**
 * 计算 A/B 差值热图：公共网格 = A 的自然尺寸（B 缩放对齐）。
 * 返回与 A 同尺寸的 ImageBitmap（可直接按 A 的几何绘制）。
 * 计算为同步像素循环（1080p ≈ 2M 像素，约 20–40ms；均衡仅多一次 256-bin 直方图+CDF，开销可忽略），
 * 由调用方控制触发时机。
 * equalize：>容差幅值按 CDF 重映射（小差异拉伸可见）；stats 出参回报全局 diff 最大值。
 */
export function computeDiffBitmap(
  bmpA: ImageBitmap,
  bmpB: ImageBitmap,
  tolerance: number,
  colormap: DiffColormap,
  equalize = false,
  stats?: { max: number },
): Promise<ImageBitmap> {
  const w = bmpA.width
  const h = bmpA.height
  const da = toImageData(bmpA, w, h)
  const db = toImageData(bmpB, w, h)
  const sa = da.data
  const sb = db.data
  const out = new Uint8ClampedArray(sa.length)
  const lut = getDiffLut(colormap)
  const tol = Math.min(128, Math.max(0, tolerance))
  const denom = 255 - tol
  // 第一遍：逐像素 diff + >容差直方图 + 全局最大值
  const npx = w * h
  const diffs = new Uint8Array(npx)
  const hist = new Uint32Array(256)
  let count = 0
  let max = 0
  for (let i = 0, p = 0; i < sa.length; i += 4, p++) {
    const dr = sa[i] - sb[i]
    const dg = sa[i + 1] - sb[i + 1]
    const db2 = sa[i + 2] - sb[i + 2]
    const ar = dr < 0 ? -dr : dr
    const ag = dg < 0 ? -dg : dg
    const ab = db2 < 0 ? -db2 : db2
    const diff = ar > ag ? (ar > ab ? ar : ab) : ag > ab ? ag : ab
    diffs[p] = diff
    if (diff > max) max = diff
    if (diff > tol) {
      hist[diff]++
      count++
    }
  }
  if (stats) stats.max = max
  // 均衡映射表（diff → LUT 下标）：cdf[diff]/count；全黑（count=0）时跳过避免除零
  let eqMap: Uint8ClampedArray | null = null
  if (equalize && count > 0) {
    eqMap = new Uint8ClampedArray(256)
    let acc = 0
    for (let v = 0; v < 256; v++) {
      acc += hist[v]
      eqMap[v] = Math.round((acc / count) * 255)
    }
  }
  // 第二遍：映射过 colormap
  for (let i = 0, p = 0; i < sa.length; i += 4, p++) {
    const diff = diffs[p]
    if (diff <= tol) {
      out[i + 3] = 255 // 黑（RGB=0）
      continue
    }
    const lv = eqMap ? eqMap[diff] : Math.round(((diff - tol) / denom) * 255)
    const idx = lv * 3
    out[i] = lut[idx]
    out[i + 1] = lut[idx + 1]
    out[i + 2] = lut[idx + 2]
    out[i + 3] = 255
  }
  return createImageBitmap(new ImageData(out, w, h))
}
