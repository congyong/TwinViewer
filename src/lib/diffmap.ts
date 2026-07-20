/**
 * A/B 差值热图（diff 布局）：
 * - 公共采样网格 = A 的自然尺寸，B 经 canvas 平滑缩放到 A 尺寸（双线性近似，视觉正确且实现简单）
 * - 逐像素差值 = 三通道最大 abs diff（max(|Δr|,|Δg|,|Δb|)，取最大而非欧氏距离：对通道级错位更敏感、计算更省）
 * - ≤容差的像素置 0（黑色）；其余按 (diff-容差)/(255-容差) 归一后过 colormap LUT
 * - colormap：inferno / viridis 为标准 colormap 的锚点分段线性插值近似（256 级，视觉与原 LUT 一致）；
 *   gray 线性；coolwarm 发散（(59,76,192)→(221,221,221)→(180,4,38)，中点浅、两端深蓝深红）
 * - 输入 bitmap 来自 decode-cache（blob 解码，canvas 不污染）；计算结果由调用方缓存，
 *   缩放/平移不重算，源图/容差/colormap 变化才重算
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
 * 计算为同步像素循环（1080p ≈ 2M 像素，约 20–40ms），由调用方控制触发时机。
 */
export function computeDiffBitmap(
  bmpA: ImageBitmap,
  bmpB: ImageBitmap,
  tolerance: number,
  colormap: DiffColormap,
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
  for (let i = 0; i < sa.length; i += 4) {
    const dr = sa[i] - sb[i]
    const dg = sa[i + 1] - sb[i + 1]
    const db2 = sa[i + 2] - sb[i + 2]
    const ar = dr < 0 ? -dr : dr
    const ag = dg < 0 ? -dg : dg
    const ab = db2 < 0 ? -db2 : db2
    const diff = ar > ag ? (ar > ab ? ar : ab) : ag > ab ? ag : ab
    if (diff <= tol) {
      out[i + 3] = 255 // 黑（RGB=0）
      continue
    }
    const idx = Math.round(((diff - tol) / denom) * 255) * 3
    out[i] = lut[idx]
    out[i + 1] = lut[idx + 1]
    out[i + 2] = lut[idx + 2]
    out[i + 3] = 255
  }
  return createImageBitmap(new ImageData(out, w, h))
}
