/**
 * GIF 编码核心（纯函数，无 DOM 依赖；recorder 与冒烟/基准共用）：
 * - 画质档计划 GIF_PLANS：帧率（高15/中12/低8 fps）、环形帧数（高 300=20s、中/低 30s）、
 *   宽度上限（高1280/中720/低480）、调色板色数（256/192/128）、是否抖动
 * - 调色板：**全局**调色板（多帧抽样一次建立，ffmpeg palettegen 式；逐帧建板会导致帧间色闪）；
 *   quantize 用 **rgb888 全彩采样**（gifenc 默认 rgb565 粗采样会丢色阶、加重色带）
 * - 抖动：gifenc 无内置 dithering，高/中档自行实现 **Floyd–Steinberg 误差扩散**
 *   （最近色查 32³ 3D LUT，误差按 7/3/5/1 十六分扩散；低档直映射省 CPU）
 * - 内存：高档 15fps×20s=300 帧 @720p RGBA ≈ 1.1GB（450 帧 30s ≈ 1.66GB 不可接受，
 *   故高档限 20s；GIF_MAX_BYTES 兜底防超大裁剪超预算）
 */
import { GIFEncoder, quantize } from 'gifenc'

export type GifQuality = 'high' | 'medium' | 'low'

export interface GifPlan {
  /** 采集帧率 */
  fps: number
  /** 环形缓冲最大帧数（决定最长保留秒数 = maxFrames/fps） */
  maxFrames: number
  /** 帧宽度上限（等比缩放，高档不缩放仅超宽限 1280） */
  widthCap: number
  /** 全局调色板色数 */
  colors: number
  /** Floyd–Steinberg 抖动开关 */
  dither: boolean
}

export const GIF_PLANS: Record<GifQuality, GifPlan> = {
  high: { fps: 15, maxFrames: 300 /* 20s */, widthCap: 1280, colors: 256, dither: true },
  medium: { fps: 12, maxFrames: 360 /* 30s */, widthCap: 720, colors: 192, dither: true },
  low: { fps: 8, maxFrames: 240 /* 30s */, widthCap: 480, colors: 128, dither: false },
}

/** 帧缓冲字节预算（≈1.25GB；720p 高档 300 帧 ≈1.1GB 可放开，超出则缩帧数兜底） */
export const GIF_MAX_BYTES = 1_250_000_000

/** 按裁剪尺寸与画质档计算 GIF 帧尺寸（等比，宽 ≤ widthCap） */
export function gifFrameDims(cropW: number, cropH: number, quality: GifQuality): { w: number; h: number } {
  const cap = GIF_PLANS[quality].widthCap
  const scale = Math.min(1, cap / Math.max(1, cropW))
  return {
    w: Math.max(2, Math.round(cropW * scale)),
    h: Math.max(2, Math.round(cropH * scale)),
  }
}

/** 考虑字节预算后的有效环形帧数上限 */
export function gifEffectiveMaxFrames(frameW: number, frameH: number, quality: GifQuality): number {
  const plan = GIF_PLANS[quality]
  const bytes = frameW * frameH * 4
  const byBudget = Math.max(1, Math.floor(GIF_MAX_BYTES / Math.max(1, bytes)))
  return Math.min(plan.maxFrames, byBudget)
}

/** 多帧抽样建全局调色板（rgb888 全彩采样；最多 24 帧、每帧约 8k 像素） */
export function buildGlobalPalette(frames: Uint8ClampedArray[], colors: number): number[][] {
  const step = Math.max(1, Math.floor(frames.length / 24))
  const picked: Uint8ClampedArray[] = []
  for (let i = 0; i < frames.length; i += step) picked.push(frames[i])
  const parts: Uint8ClampedArray[] = []
  let total = 0
  for (const f of picked) {
    const px = f.length / 4
    const stride = Math.max(1, Math.floor(px / 8000))
    const n = Math.ceil(px / stride)
    const sample = new Uint8ClampedArray(n * 4)
    for (let p = 0, j = 0; p < px; p += stride, j++) {
      sample[j * 4] = f[p * 4]
      sample[j * 4 + 1] = f[p * 4 + 1]
      sample[j * 4 + 2] = f[p * 4 + 2]
      sample[j * 4 + 3] = 255
    }
    parts.push(sample)
    total += sample.length
  }
  const all = new Uint8ClampedArray(total)
  let off = 0
  for (const p of parts) {
    all.set(p, off)
    off += p.length
  }
  return quantize(all, colors, { format: 'rgb888' })
}

/** 32³ 3D LUT：量化 RGB → 最近调色板索引（32768×色数 距离计算，每段编码只建一次） */
export function buildPaletteLut(palette: number[][]): Uint8Array {
  const lut = new Uint8Array(32 * 32 * 32)
  for (let ri = 0; ri < 32; ri++) {
    const r = ri * 8 + 4
    for (let gi = 0; gi < 32; gi++) {
      const g = gi * 8 + 4
      for (let bi = 0; bi < 32; bi++) {
        const b = bi * 8 + 4
        let best = 0
        let bestD = Infinity
        for (let p = 0; p < palette.length; p++) {
          const c = palette[p]
          const dr = r - c[0]
          const dg = g - c[1]
          const db = b - c[2]
          const d = dr * dr + dg * dg + db * db
          if (d < bestD) {
            bestD = d
            best = p
          }
        }
        lut[(ri << 10) | (gi << 5) | bi] = best
      }
    }
  }
  return lut
}

/** 单帧映射为调色板索引（dither=true 时 Floyd–Steinberg 误差扩散） */
export function mapFrameToPalette(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  palette: number[][],
  lut: Uint8Array,
  dither: boolean,
): Uint8Array {
  const out = new Uint8Array(w * h)
  if (!dither) {
    for (let p = 0; p < w * h; p++) {
      out[p] = lut[((data[p * 4] >> 3) << 10) | ((data[p * 4 + 1] >> 3) << 5) | (data[p * 4 + 2] >> 3)]
    }
    return out
  }
  // FS 误差扩散：当前行/下一行误差缓冲（左→右单向，7/16 → 右，3/16 → 左下，5/16 → 下，1/16 → 右下）
  let errR = new Float32Array(w + 2)
  let errG = new Float32Array(w + 2)
  let errB = new Float32Array(w + 2)
  let nxtR = new Float32Array(w + 2)
  let nxtG = new Float32Array(w + 2)
  let nxtB = new Float32Array(w + 2)
  for (let y = 0; y < h; y++) {
    nxtR.fill(0)
    nxtG.fill(0)
    nxtB.fill(0)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const i = p * 4
      const r = Math.min(255, Math.max(0, data[i] + errR[x + 1]))
      const g = Math.min(255, Math.max(0, data[i + 1] + errG[x + 1]))
      const b = Math.min(255, Math.max(0, data[i + 2] + errB[x + 1]))
      const idx = lut[(((r | 0) >> 3) << 10) | (((g | 0) >> 3) << 5) | ((b | 0) >> 3)]
      out[p] = idx
      const c = palette[idx]
      const dr = r - c[0]
      const dg = g - c[1]
      const db = b - c[2]
      errR[x + 2] += (dr * 7) / 16
      errG[x + 2] += (dg * 7) / 16
      errB[x + 2] += (db * 7) / 16
      nxtR[x] += (dr * 3) / 16
      nxtG[x] += (dg * 3) / 16
      nxtB[x] += (db * 3) / 16
      nxtR[x + 1] += (dr * 5) / 16
      nxtG[x + 1] += (dg * 5) / 16
      nxtB[x + 1] += (db * 5) / 16
      nxtR[x + 2] += dr / 16
      nxtG[x + 2] += dg / 16
      nxtB[x + 2] += db / 16
    }
    ;[errR, nxtR] = [nxtR, errR]
    ;[errG, nxtG] = [nxtG, errG]
    ;[errB, nxtB] = [nxtB, errB]
  }
  return out
}

/** 编码帧序列为 GIF Blob（全局调色板：首帧写板，后续帧复用；无限循环）。
 *  delaysMs 可选逐帧时长（切换抓帧模式按真实抓帧时间戳；缺省 = 档位 fps 均匀时长） */
export function encodeGifFrames(
  frames: Uint8ClampedArray[],
  w: number,
  h: number,
  quality: GifQuality,
  delaysMs?: number[],
): Promise<Blob> {
  if (frames.length === 0) return Promise.reject(new Error('无可用帧'))
  const plan = GIF_PLANS[quality]
  const palette = buildGlobalPalette(frames, plan.colors)
  const lut = buildPaletteLut(palette)
  const uniform = Math.round(1000 / plan.fps)
  const gif = GIFEncoder()
  for (let f = 0; f < frames.length; f++) {
    const idx = mapFrameToPalette(frames[f], w, h, palette, lut, plan.dither)
    const delay = delaysMs?.[f] ?? uniform
    if (f === 0) gif.writeFrame(idx, w, h, { palette, delay, repeat: 0 })
    else gif.writeFrame(idx, w, h, { delay })
  }
  gif.finish()
  return Promise.resolve(new Blob([gif.bytes() as BlobPart], { type: 'image/gif' }))
}
