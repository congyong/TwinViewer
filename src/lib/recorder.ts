/**
 * 显示区录制：
 * - 采集：Electron = desktopCapturer（get-window-source-id IPC）+ getUserMedia chromeMediaSource 本窗口；
 *   浏览器 = getDisplayMedia（用户选本标签页，含浏览器 UI 的限制见 README）
 * - 裁剪：隐藏 <video> 播放流 → 镜像 canvas 按显示区（<main>）rect 裁剪绘制（15fps）→ captureStream 供编码
 * - 视频：MediaRecorder，mime 运行时探测（优先 video/mp4，不支持落 webm 并在 UI 明示）；码率按画质档于录制开始确定
 * - GIF 两种抓帧方式（开录前配置，recFormat='video' 时传 'none' 不收集）：
 *   · 连续采样 continuous：按画质档定时抓帧（GIF_PLANS——高 15fps/≤1280 宽/20s 环形、中 12fps/≤720 宽/30s、
 *     低 8fps/≤480 宽/30s），停止后均匀帧时长编码
 *   · 切换抓帧 switch：不启动定时器，由 store 订阅"当前显示图像变化"（或 C 键手动）调 grabFrame() 事件驱动抓帧；
 *     **全分辨率不降采样**（显示区设备像素原尺寸，仅 >2560 宽设安全上限 SWITCH_MAX_WIDTH），环形 60 帧
 *     （GIF_MAX_BYTES 预算兜底），per-frame delay = 真实抓帧时间戳间隔（最后一帧固定 1s）
 *   抓帧画面 = 本窗口采集流当前帧按显示区 rect 裁剪（OS 合成器视角，与屏幕所见一致：含分割线/并排布局/浮层）
 * - 停止后经 gif-core 编码（rgb888 全局调色板 + 高/中档 FS 抖动）
 * - 时长上限 10 分钟自动停；discardCapture 供视图切换/卸载异常清理
 */
import { isElectron } from '@/lib/fs-provider'
import {
  GIF_MAX_BYTES,
  GIF_PLANS,
  encodeGifFrames,
  gifEffectiveMaxFrames,
  gifFrameDims,
  type GifQuality,
} from '@/lib/gif-core'

export type RecQuality = GifQuality
/** GIF 抓帧方式：连续采样 / 切换抓帧 / 不收集（视频格式） */
export type GifMode = 'continuous' | 'switch' | 'none'

const VIDEO_FPS = 15
export const REC_MAX_SECONDS = 600

/** 切换抓帧：全分辨率安全上限（宽 >2560 才等比缩小；典型显示区 1080p~2K 不触发） */
export const SWITCH_MAX_WIDTH = 2560
/** 切换抓帧：环形帧数上限（帧少单帧大；60 帧 × 1440p RGBA ≈ 885MB，预算内） */
export const SWITCH_MAX_FRAMES = 60

const BITRATES: Record<RecQuality, number> = { high: 8_000_000, medium: 4_000_000, low: 2_000_000 }

/** 运行时探测 MediaRecorder 可用容器（优先 mp4） */
export function pickVideoMime(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = ['video/mp4;codecs="avc1.42E01E"', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m
    } catch {
      /* 继续探测 */
    }
  }
  return ''
}

export function mp4Available(): boolean {
  return pickVideoMime().includes('mp4')
}

interface Session {
  stream: MediaStream
  video: HTMLVideoElement
  mirror: HTMLCanvasElement
  mirrorTimer: number
  recorder: MediaRecorder | null
  chunks: Blob[]
  mime: string
  gifMode: GifMode
  gifCanvas: HTMLCanvasElement | null
  gctx: CanvasRenderingContext2D | null
  gifFrames: Uint8ClampedArray[]
  /** 与 gifFrames 等长的抓帧时间戳（performance.now()），切换抓帧写 per-frame delay 用 */
  gifTimes: number[]
  gifFrameSize: { w: number; h: number }
  gifMaxFrames: number
  gifTimer: number
  crop: { x: number; y: number; w: number; h: number }
}

let session: Session | null = null

/** 显示区（<main>）在窗口中的 rect（CSS 像素） */
function viewerRect(): DOMRect | null {
  const el = document.querySelector('main')
  return el ? el.getBoundingClientRect() : null
}

async function acquireStream(): Promise<MediaStream> {
  if (isElectron()) {
    const id = await window.twinview?.getWindowSourceId?.()
    if (!id) throw new Error('找不到本窗口采集源')
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        // @ts-expect-error chromeMediaSource 为 Electron/Chromium 扩展约束
        mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id },
      },
    })
  }
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('当前浏览器不支持屏幕采集')
  return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
}

/** 开始采集（镜像 + MediaRecorder + GIF 帧收集）；画质决定视频码率；gifMode 见 GifMode */
export async function startCapture(quality: RecQuality, gifMode: GifMode = 'continuous'): Promise<{ mime: string }> {
  if (session) throw new Error('已有录制会话')
  const stream = await acquireStream()
  const video = document.createElement('video')
  video.muted = true
  video.srcObject = stream
  await video.play()

  const rect = viewerRect()
  const scale = rect ? video.videoWidth / Math.max(1, window.innerWidth) : 1
  const cropW = Math.max(2, Math.round((rect?.width ?? video.videoWidth) * scale))
  const cropH = Math.max(2, Math.round((rect?.height ?? video.videoHeight) * scale))
  const cropX = rect ? Math.round(rect.left * scale) : 0
  const cropY = rect ? Math.round(rect.top * scale) : 0
  const crop = { x: cropX, y: cropY, w: cropW, h: cropH }

  // 镜像 canvas（裁剪显示区，偶数尺寸兼容编码器）
  const mirror = document.createElement('canvas')
  mirror.width = cropW % 2 === 0 ? cropW : cropW - 1
  mirror.height = cropH % 2 === 0 ? cropH : cropH - 1
  const mctx = mirror.getContext('2d')
  if (!mctx) throw new Error('canvas 2d 不可用')
  const drawMirror = () => {
    mctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, mirror.width, mirror.height)
  }
  drawMirror()
  const mirrorTimer = window.setInterval(drawMirror, Math.round(1000 / VIDEO_FPS))

  // GIF 帧收集设置：连续 = 定时抓帧（档位尺寸/帧率/环形上限）；切换 = 事件驱动全分辨率（不启动定时器）
  let dims = { w: 0, h: 0 }
  let maxFrames = 0
  let gifCanvas: HTMLCanvasElement | null = null
  let gctx: CanvasRenderingContext2D | null = null
  let gifTimer = 0
  const gifFrames: Uint8ClampedArray[] = []
  const gifTimes: number[] = []
  if (gifMode === 'continuous') {
    dims = gifFrameDims(cropW, cropH, quality)
    maxFrames = gifEffectiveMaxFrames(dims.w, dims.h, quality)
  } else if (gifMode === 'switch') {
    // 全分辨率：显示区设备像素原尺寸，仅超 SWITCH_MAX_WIDTH 宽设安全上限
    const sc = Math.min(1, SWITCH_MAX_WIDTH / Math.max(1, cropW))
    dims = { w: Math.max(2, Math.round(cropW * sc)), h: Math.max(2, Math.round(cropH * sc)) }
    maxFrames = Math.min(SWITCH_MAX_FRAMES, Math.max(1, Math.floor(GIF_MAX_BYTES / Math.max(1, dims.w * dims.h * 4))))
  }
  if (gifMode !== 'none') {
    gifCanvas = document.createElement('canvas')
    gifCanvas.width = dims.w
    gifCanvas.height = dims.h
    gctx = gifCanvas.getContext('2d', { willReadFrequently: true })
    if (!gctx) throw new Error('canvas 2d 不可用')
    if (gifMode === 'continuous') {
      const plan = GIF_PLANS[quality]
      const c = gifCanvas
      const g = gctx
      gifTimer = window.setInterval(() => {
        g.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, c.width, c.height)
        gifFrames.push(g.getImageData(0, 0, c.width, c.height).data.slice())
        gifTimes.push(performance.now())
        if (gifFrames.length > maxFrames) {
          gifFrames.shift()
          gifTimes.shift()
        }
      }, Math.round(1000 / plan.fps))
    }
  }

  // MediaRecorder（无可用容器时仅 GIF 可用）
  const mime = pickVideoMime()
  let recorder: MediaRecorder | null = null
  const chunks: Blob[] = []
  if (mime) {
    recorder = new MediaRecorder(mirror.captureStream(VIDEO_FPS), {
      mimeType: mime,
      videoBitsPerSecond: BITRATES[quality],
    })
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    recorder.start(1000)
  }

  session = {
    stream, video, mirror, mirrorTimer, recorder, chunks, mime,
    gifMode, gifCanvas, gctx, gifFrames, gifTimes, gifFrameSize: dims, gifMaxFrames: maxFrames, gifTimer, crop,
  }
  return { mime }
}

/** 切换抓帧：抓当前显示区整幅画面一帧（全分辨率）。返回累计帧数；无会话/非切换模式返回 -1 */
export function grabFrame(): number {
  const s = session
  if (!s || s.gifMode !== 'switch' || !s.gctx) return -1
  const { w, h } = s.gifFrameSize
  s.gctx.drawImage(s.video, s.crop.x, s.crop.y, s.crop.w, s.crop.h, 0, 0, w, h)
  s.gifFrames.push(s.gctx.getImageData(0, 0, w, h).data.slice())
  s.gifTimes.push(performance.now())
  if (s.gifFrames.length > s.gifMaxFrames) {
    s.gifFrames.shift()
    s.gifTimes.shift()
  }
  return s.gifFrames.length
}

/** 当前 GIF 会话信息（录制徽标帧数 / 冒烟断言用） */
export function gifSessionInfo(): { mode: GifMode; w: number; h: number; count: number } | null {
  if (!session) return null
  return { mode: session.gifMode, w: session.gifFrameSize.w, h: session.gifFrameSize.h, count: session.gifFrames.length }
}

function teardownMedia(): void {
  if (!session) return
  clearInterval(session.mirrorTimer)
  clearInterval(session.gifTimer)
  session.video.srcObject = null
  for (const t of session.stream.getTracks()) t.stop()
}

/** 停止并产出视频 blob（无视频容器时返回 null；GIF 帧仍在会话内可取） */
export function stopCapture(): Promise<{ blob: Blob | null; mime: string }> {
  const s = session
  if (!s) return Promise.resolve({ blob: null, mime: '' })
  const mime = s.mime
  return new Promise((resolve) => {
    if (s.recorder) {
      s.recorder.onstop = () => {
        teardownMedia()
        resolve({ blob: new Blob(s.chunks, { type: mime }), mime })
      }
      try {
        s.recorder.stop()
      } catch {
        teardownMedia()
        resolve({ blob: null, mime })
      }
    } else {
      teardownMedia()
      resolve({ blob: null, mime })
    }
  })
}

/** 放弃会话（取消保存 / 异常清理） */
export function discardCapture(): void {
  if (!session) return
  try {
    if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop()
  } catch {
    /* 忽略 */
  }
  teardownMedia()
  session = null
}

/** 标记会话结束（stopCapture 成功后调用） */
export function clearSession(): void {
  session = null
}

/** GIF 帧数（停止后编码用） */
export function gifFrameCount(): number {
  return session?.gifFrames.length ?? 0
}

/** gif-core 编码收集帧（全局 rgb888 调色板 + 高/中档 FS 抖动）。
 *  切换抓帧：per-frame delay = 真实抓帧时间戳间隔（最后一帧固定 1s；间隔下限 20ms 防播放器异常） */
export function encodeGif(quality: RecQuality): Promise<Blob> {
  const s = session
  if (!s || s.gifFrames.length === 0) return Promise.reject(new Error('无可用帧'))
  let delays: number[] | undefined
  if (s.gifMode === 'switch') {
    delays = s.gifTimes.map((t, i) =>
      i + 1 < s.gifTimes.length ? Math.max(20, Math.round(s.gifTimes[i + 1] - t)) : 1000,
    )
  }
  return encodeGifFrames(s.gifFrames, s.gifFrameSize.w, s.gifFrameSize.h, quality, delays)
}
