/**
 * 显示区录制：
 * - 采集：Electron = desktopCapturer（get-window-source-id IPC）+ getUserMedia chromeMediaSource 本窗口；
 *   浏览器 = getDisplayMedia（用户选本标签页，含浏览器 UI 的限制见 README）
 * - 裁剪：隐藏 <video> 播放流 → 镜像 canvas 按显示区（<main>）rect 裁剪绘制（15fps）→ captureStream 供编码
 * - 视频：MediaRecorder，mime 运行时探测（优先 video/mp4，不支持落 webm 并在 UI 明示）；码率按画质档于录制开始确定
 * - GIF：录制时按画质档（GIF_PLANS，见 gif-core.ts）同步收集帧——高 15fps/≤1280 宽/20s 环形、
 *   中 12fps/≤720 宽/30s、低 8fps/≤480 宽/30s；停止后经 gif-core 编码（rgb888 全局调色板 + 高/中档 FS 抖动）
 * - 时长上限 10 分钟自动停；stopAndDiscard 供视图切换/卸载异常清理
 */
import { isElectron } from '@/lib/fs-provider'
import {
  GIF_PLANS,
  encodeGifFrames,
  gifEffectiveMaxFrames,
  gifFrameDims,
  type GifQuality,
} from '@/lib/gif-core'

export type RecQuality = GifQuality

const VIDEO_FPS = 15
export const REC_MAX_SECONDS = 600

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
  gifCanvas: HTMLCanvasElement
  gifFrames: Uint8ClampedArray[]
  gifFrameSize: { w: number; h: number }
  gifTimer: number
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

/** 开始采集（镜像 + MediaRecorder + GIF 帧收集）；画质决定视频码率 */
export async function startCapture(quality: RecQuality): Promise<{ mime: string }> {
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

  // GIF 帧收集（按画质档：帧率/尺寸/环形上限；字节预算兜底）
  const plan = GIF_PLANS[quality]
  const dims = gifFrameDims(cropW, cropH, quality)
  const maxFrames = gifEffectiveMaxFrames(dims.w, dims.h, quality)
  const gifCanvas = document.createElement('canvas')
  gifCanvas.width = dims.w
  gifCanvas.height = dims.h
  const gctx = gifCanvas.getContext('2d', { willReadFrequently: true })
  if (!gctx) throw new Error('canvas 2d 不可用')
  const gifFrames: Uint8ClampedArray[] = []
  const gifTimer = window.setInterval(() => {
    gctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, dims.w, dims.h)
    gifFrames.push(gctx.getImageData(0, 0, dims.w, dims.h).data.slice())
    if (gifFrames.length > maxFrames) gifFrames.shift()
  }, Math.round(1000 / plan.fps))

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

  session = { stream, video, mirror, mirrorTimer, recorder, chunks, mime, gifCanvas, gifFrames, gifFrameSize: dims, gifTimer }
  return { mime }
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

/** gif-core 编码收集帧（全局 rgb888 调色板 + 高/中档 FS 抖动；最长保留秒数按画质档） */
export function encodeGif(quality: RecQuality): Promise<Blob> {
  const s = session
  if (!s || s.gifFrames.length === 0) return Promise.reject(new Error('无可用帧'))
  return encodeGifFrames(s.gifFrames, s.gifFrameSize.w, s.gifFrameSize.h, quality)
}
