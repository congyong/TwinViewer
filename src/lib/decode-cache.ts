/**
 * 会话级图片解码缓存：
 * - key = entry.id；value = { bitmap（优先 createImageBitmap，失败回退 HTMLImageElement/blob URL）, url, natural, bytes }
 * - **按字节预算管理**：每张解码图字节数按 width × height × 4（RGBA）计；
 *   **总预算默认 1GB（BYTE_BUDGET）**。插入新图导致超预算时按 LRU（最久未用）淘汰，
 *   淘汰时 bitmap.close() + revoke blob URL
 * - **pin 保护**：当前正在显示的图通过 pinDecoded() 加保护计数，计数 > 0 不可被淘汰
 *   （极端情况下全部 pinned 时允许暂时超预算，绝不淘汰在显图）
 * - Electron 经 readFileBuffer IPC 拿到字节后 new Blob([buffer]) 解码，
 *   得到的 blob 同源、不污染 canvas（直方图/EXIF/探针分析层可用）；
 *   浏览器模式直接 fetch(entry.getUrl()) 的 blob: URL
 * - **缩放算法切换与缓存无关**：bitmap 只与 entry.id 相关，算法仅影响"bitmap → 屏幕"的绘制，
 *   切算法不会使缓存失效（命中日志可验证）
 * - 退出对比会话（返回浏览）/ 换目录时 clearDecodeSession() 全量释放；
 *   generation 计数保证清空后在途解码结果直接释放、不回填缓存
 * - 调试日志：localStorage 设 twinview.debugCache=1 后 console 输出 命中/未命中/淘汰/预算
 */
import type { ImageEntry } from './fs-provider'
import { getFSProvider } from './fs-provider'

export interface DecodedImage {
  bitmap: ImageBitmap | null
  /** blob: URL（解码成功）或 entry.getUrl() 的兜底 URL */
  url: string
  natural: { w: number; h: number }
  /** 字节数 = width × height × 4 */
  bytes: number
}

/** 解码缓存总字节预算：1GB（每张按 width × height × 4 字节计） */
const BYTE_BUDGET = 1024 * 1024 * 1024

interface CacheRecord {
  value: DecodedImage
  /** 最近使用时间戳（LRU 判据） */
  last: number
}

const cache = new Map<string, CacheRecord>()
/** pin 保护计数（正在显示的图层）；>0 时不可淘汰 */
const pins = new Map<string, number>()
const inflight = new Map<string, Promise<DecodedImage | null>>()
let totalBytes = 0
let generation = 0

function debugEnabled(): boolean {
  try {
    return localStorage.getItem('twinview.debugCache') === '1'
  } catch {
    return false
  }
}

function log(...args: unknown[]): void {
  if (debugEnabled()) console.log('[decode-cache]', ...args)
}

function fmtMB(n: number): string {
  return `${(n / 1048576).toFixed(1)}MB`
}

/** 取图片字节：Electron 走 readFileBuffer IPC；浏览器 fetch blob: URL */
async function getEntryBlob(entry: ImageEntry): Promise<Blob> {
  const provider = getFSProvider()
  if (provider.kind === 'electron' && provider.readFileBuffer) {
    const buf = await provider.readFileBuffer(entry.path)
    if (!buf || buf.byteLength === 0) throw new Error('读取文件失败')
    return new Blob([buf as BlobPart])
  }
  const url = await entry.getUrl()
  const res = await fetch(url)
  if (!res.ok) throw new Error(`读取失败 (${res.status})`)
  return res.blob()
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
}

async function decode(entry: ImageEntry): Promise<DecodedImage | null> {
  // 首选：字节 → Blob → createImageBitmap（失败回退 HTMLImageElement + blob URL）
  try {
    const blob = await getEntryBlob(entry)
    const url = URL.createObjectURL(blob)
    try {
      const bitmap = await createImageBitmap(blob)
      const w = bitmap.width
      const h = bitmap.height
      return { bitmap, url, natural: { w, h }, bytes: w * h * 4 }
    } catch {
      try {
        const img = await loadImage(url)
        const w = img.naturalWidth || 1
        const h = img.naturalHeight || 1
        return { bitmap: null, url, natural: { w, h }, bytes: w * h * 4 }
      } catch {
        URL.revokeObjectURL(url)
        return null
      }
    }
  } catch {
    // 兜底：直接用 entry 的 URL（twinview:// 仅 <img> 可用，canvas 会被污染）
    try {
      const url = await entry.getUrl()
      const img = await loadImage(url)
      const w = img.naturalWidth || 1
      const h = img.naturalHeight || 1
      return { bitmap: null, url, natural: { w, h }, bytes: w * h * 4 }
    } catch {
      return null
    }
  }
}

function releaseValue(value: DecodedImage): void {
  value.bitmap?.close()
  if (value.url.startsWith('blob:')) URL.revokeObjectURL(value.url)
}

/** 超预算时按 LRU 淘汰（跳过 pinned）；全部 pinned 时允许暂时超预算 */
function evictIfNeeded(): void {
  while (totalBytes > BYTE_BUDGET) {
    let victim: string | null = null
    let oldest = Infinity
    for (const [k, v] of cache) {
      if ((pins.get(k) ?? 0) > 0) continue
      if (v.last < oldest) {
        oldest = v.last
        victim = k
      }
    }
    if (victim === null) {
      log('超预算但全部在显（pin），暂不清退', fmtMB(totalBytes))
      return
    }
    const rec = cache.get(victim)
    cache.delete(victim)
    if (rec) {
      totalBytes -= rec.value.bytes
      releaseValue(rec.value)
      log('淘汰', victim.slice(-48), `-${fmtMB(rec.value.bytes)}`, '预算占用', fmtMB(totalBytes))
    }
  }
}

/** 保护当前显示的图片不被淘汰；返回解除函数（图层卸载/切换时调用） */
export function pinDecoded(id: string): () => void {
  pins.set(id, (pins.get(id) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const n = (pins.get(id) ?? 0) - 1
    if (n <= 0) pins.delete(id)
    else pins.set(id, n)
    // 解除 pin 后若超预算可继续淘汰
    evictIfNeeded()
  }
}

/** 取解码结果（命中缓存 / 在途去重 / 未命中解码并入缓存） */
export function getDecoded(entry: ImageEntry): Promise<DecodedImage | null> {
  const hit = cache.get(entry.id)
  if (hit) {
    hit.last = Date.now()
    log('命中', entry.name, '预算占用', fmtMB(totalBytes))
    return Promise.resolve(hit.value)
  }
  const pending = inflight.get(entry.id)
  if (pending) return pending
  log('未命中，实时解码', entry.name)
  const gen = generation
  const p = decode(entry).then((value) => {
    inflight.delete(entry.id)
    if (value && gen === generation) {
      cache.set(entry.id, { value, last: Date.now() })
      totalBytes += value.bytes
      log('入缓存', entry.name, `+${fmtMB(value.bytes)}`, '预算占用', fmtMB(totalBytes))
      evictIfNeeded()
    } else if (value) {
      // 会话已清空：不回填，直接释放
      releaseValue(value)
    }
    return value
  })
  inflight.set(entry.id, p)
  return p
}

/** 预解码一批图片（并发限制，默认 3）；已在缓存中的跳过 */
export async function preloadDecode(entries: ImageEntry[], concurrency = 3): Promise<void> {
  const queue = entries.filter((e) => !cache.has(e.id) && !inflight.has(e.id))
  if (queue.length > 0) log('预取', queue.length, '张')
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const e = queue.shift()
      if (!e) return
      await getDecoded(e)
    }
  })
  await Promise.all(workers)
}

/** 清空会话缓存（退出对比/换目录时调用）；在途解码结果落地即释放 */
export function clearDecodeSession(): void {
  generation += 1
  for (const it of cache.values()) releaseValue(it.value)
  cache.clear()
  totalBytes = 0
  log('会话缓存已清空')
}

/** 缓存占用（调试面板/日志用） */
export function cacheStats(): { count: number; bytes: number; budget: number } {
  return { count: cache.size, bytes: totalBytes, budget: BYTE_BUDGET }
}
