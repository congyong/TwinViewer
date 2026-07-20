/**
 * 图片信息：直方图计算与 EXIF 读取（按 entry.id 缓存，避免重复计算）
 * 数据源走会话解码缓存（blob 同源，canvas 不污染）：
 * - 直方图：drawImage 解码缓存的 bitmap/img → getImageData 抽样
 * - EXIF：fetch 缓存的 blob: URL → exifr.parse(blob)
 */
import exifr from 'exifr'
import type { ImageEntry } from '@/lib/fs-provider'
import { getDecoded } from '@/lib/decode-cache'

export interface HistoData {
  r: number[]
  g: number[]
  b: number[]
  l: number[]
}

export interface ExifInfo {
  dateTime?: string
  camera?: string
  lens?: string
  iso?: number
  fNumber?: number
  exposureTime?: number
  focalLength?: number
  gps?: string
}

const histoCache = new Map<string, HistoData | null>()
const exifCache = new Map<string, ExifInfo | null>()

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
}

/** 抽样（最长边 ≤256px）计算 RGB/亮度直方图；解码失败或 canvas 被污染时返回 null */
export async function computeHistogram(entry: ImageEntry): Promise<HistoData | null> {
  const cached = histoCache.get(entry.id)
  if (cached !== undefined) return cached
  try {
    const dec = await getDecoded(entry)
    if (!dec) throw new Error('decode failed')
    const source = dec.bitmap ?? (await loadImage(dec.url))
    const sw = dec.natural.w
    const sh = dec.natural.h
    const scale = Math.min(1, 256 / Math.max(sw, sh))
    const w = Math.max(1, Math.round(sw * scale))
    const h = Math.max(1, Math.round(sh * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(source, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h).data
    const r = new Array<number>(256).fill(0)
    const g = new Array<number>(256).fill(0)
    const b = new Array<number>(256).fill(0)
    const l = new Array<number>(256).fill(0)
    for (let i = 0; i < data.length; i += 4) {
      const rv = data[i]
      const gv = data[i + 1]
      const bv = data[i + 2]
      r[rv] += 1
      g[gv] += 1
      b[bv] += 1
      l[Math.round(0.2126 * rv + 0.7152 * gv + 0.0722 * bv)] += 1
    }
    const res: HistoData = { r, g, b, l }
    histoCache.set(entry.id, res)
    return res
  } catch {
    histoCache.set(entry.id, null)
    return null
  }
}

/** 读取常见 EXIF 字段（JPEG/TIFF/PNG eXIf）；不支持或失败返回 null */
export async function readExif(entry: ImageEntry): Promise<ExifInfo | null> {
  const cached = exifCache.get(entry.id)
  if (cached !== undefined) return cached
  try {
    const dec = await getDecoded(entry)
    if (!dec || !dec.url.startsWith('blob:')) throw new Error('no blob')
    const blob = await (await fetch(dec.url)).blob()
    const raw = (await exifr.parse(blob, {
      pick: [
        'DateTimeOriginal',
        'CreateDate',
        'Make',
        'Model',
        'LensModel',
        'LensMake',
        'ISO',
        'FNumber',
        'ExposureTime',
        'FocalLength',
        'latitude',
        'longitude',
      ],
    })) as Record<string, unknown> | undefined
    if (!raw) {
      exifCache.set(entry.id, null)
      return null
    }
    const info: ExifInfo = {}
    const dt = (raw.DateTimeOriginal ?? raw.CreateDate) as Date | string | undefined
    if (dt) info.dateTime = dt instanceof Date ? dt.toLocaleString('zh-CN') : String(dt)
    const make = raw.Make ? String(raw.Make).trim() : ''
    const model = raw.Model ? String(raw.Model).trim() : ''
    if (make || model) info.camera = model.startsWith(make) ? model : `${make} ${model}`.trim()
    if (raw.LensModel) info.lens = String(raw.LensModel)
    if (typeof raw.ISO === 'number') info.iso = raw.ISO
    if (typeof raw.FNumber === 'number') info.fNumber = raw.FNumber
    if (typeof raw.ExposureTime === 'number') info.exposureTime = raw.ExposureTime
    if (typeof raw.FocalLength === 'number') info.focalLength = raw.FocalLength
    if (typeof raw.latitude === 'number' && typeof raw.longitude === 'number') {
      info.gps = `${raw.latitude.toFixed(5)}, ${raw.longitude.toFixed(5)}`
    }
    const hasAny = Object.keys(info).length > 0
    exifCache.set(entry.id, hasAny ? info : null)
    return hasAny ? info : null
  } catch {
    exifCache.set(entry.id, null)
    return null
  }
}
