import { useEffect, useRef, useState } from 'react'
import type { ImageEntry } from '@/lib/fs-provider'
import type { ExifInfo, HistoData } from '@/lib/image-info'
import { computeHistogram, readExif } from '@/lib/image-info'
import { formatBytes } from '@/lib/format'
import { useAppStore } from '@/store/appStore'
import { cn } from '@/lib/utils'

/**
 * 直方图绘制（220×100 含 X 轴）：
 * 上部为亮度填充 + RGB 折线；底部 X 轴带值域刻度 0 / 64 / 128 / 192 / 255
 */
function drawHistogram(canvas: HTMLCanvasElement, data: HistoData) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const W = canvas.width
  const H = canvas.height
  const axisH = 14
  const plotH = H - axisH
  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = 'rgba(0,0,0,0.3)'
  ctx.fillRect(0, 0, W, plotH)

  const max = Math.max(1, ...data.l, ...data.r, ...data.g, ...data.b)
  const barW = W / 256
  // 刻度竖向参考线（先画，置于曲线之下）
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'
  ctx.lineWidth = 1
  for (const v of [64, 128, 192]) {
    const x = Math.round((v / 255) * (W - 1)) + 0.5
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, plotH)
    ctx.stroke()
  }
  // 亮度填充（白，半透明）
  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  for (let i = 0; i < 256; i++) {
    const h = (data.l[i] / max) * plotH
    ctx.fillRect(i * barW, plotH - h, Math.max(barW, 0.6), h)
  }
  // RGB 折线
  const drawLine = (arr: number[], color: string) => {
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let i = 0; i < 256; i++) {
      const y = plotH - (arr[i] / max) * plotH
      if (i === 0) ctx.moveTo(0, y)
      else ctx.lineTo(i * barW, y)
    }
    ctx.stroke()
  }
  drawLine(data.r, 'rgba(255,80,80,0.9)')
  drawLine(data.g, 'rgba(80,255,80,0.9)')
  drawLine(data.b, 'rgba(90,140,255,0.9)')

  // X 轴：刻度线 + 数字标签 0 / 64 / 128 / 192 / 255
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'
  ctx.beginPath()
  ctx.moveTo(0, plotH + 0.5)
  ctx.lineTo(W, plotH + 0.5)
  ctx.stroke()
  ctx.fillStyle = 'rgba(255,255,255,0.6)'
  ctx.font = '9px sans-serif'
  for (const v of [0, 64, 128, 192, 255]) {
    const x = (v / 255) * (W - 1)
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'
    ctx.beginPath()
    ctx.moveTo(Math.round(x) + 0.5, plotH)
    ctx.lineTo(Math.round(x) + 0.5, plotH + 3)
    ctx.stroke()
    const label = String(v)
    const tx = v === 0 ? x + 7 : v === 255 ? x - 9 : x
    ctx.fillText(label, tx, H - 3)
  }
}

function ExifBlock({ exif }: { exif: ExifInfo | null | undefined }) {
  if (exif === undefined) return <div className="text-neutral-500">EXIF 读取中…</div>
  if (exif === null) return <div className="text-neutral-500">无 EXIF</div>
  const rows: [string, string][] = []
  if (exif.dateTime) rows.push(['拍摄时间', exif.dateTime])
  if (exif.camera) rows.push(['相机', exif.camera])
  if (exif.lens) rows.push(['镜头', exif.lens])
  if (exif.iso !== undefined) rows.push(['ISO', String(exif.iso)])
  if (exif.fNumber !== undefined) rows.push(['光圈', `f/${exif.fNumber}`])
  if (exif.exposureTime !== undefined)
    rows.push(['快门', exif.exposureTime < 1 ? `1/${Math.round(1 / exif.exposureTime)}s` : `${exif.exposureTime}s`])
  if (exif.focalLength !== undefined) rows.push(['焦距', `${exif.focalLength}mm`])
  if (exif.gps) rows.push(['GPS', exif.gps])
  if (rows.length === 0) return <div className="text-neutral-500">无 EXIF</div>
  return (
    <div className="space-y-0.5">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-2">
          <span className="w-14 shrink-0 text-neutral-500">{k}</span>
          <span className="min-w-0 truncate text-neutral-200" title={v}>{v}</span>
        </div>
      ))}
    </div>
  )
}

interface InfoOverlayProps {
  entry: ImageEntry
  meta: { w: number; h: number } | null
  zoom: number
  index?: number
  total?: number
  /** 上方有 A/B 等标签时向下让位 */
  offsetTop?: boolean
}

/**
 * 视图格左上角信息浮层。
 * 两个独立开关（都关时不渲染）：
 * - 信息浮层（I 键 / store.infoVisible）：基本信息 + EXIF
 * - 直方图（工具栏 toggle / store.histoVisible）：固定展开的直方图（带值域刻度）
 * 两个都开时在浮层里依次排布。
 */
export function InfoOverlay({ entry, meta, zoom, index, total, offsetTop }: InfoOverlayProps) {
  const infoVisible = useAppStore((s) => s.infoVisible)
  const histoVisible = useAppStore((s) => s.histoVisible)
  const [histo, setHisto] = useState<HistoData | null | undefined>(undefined)
  const [exif, setExif] = useState<ExifInfo | null | undefined>(undefined)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // 换图时重置并按需重新读取
  useEffect(() => {
    setHisto(undefined)
    setExif(undefined)
    if (!infoVisible) return
    let cancelled = false
    void readExif(entry).then((x) => {
      if (!cancelled) setExif(x)
    })
    return () => {
      cancelled = true
    }
  }, [entry, infoVisible])

  // 直方图：工具栏 toggle 开启时计算（数据源 = 会话解码缓存，按 entry 缓存）
  useEffect(() => {
    if (!histoVisible || histo !== undefined) return
    let cancelled = false
    void computeHistogram(entry).then((h) => {
      if (!cancelled) setHisto(h)
    })
    return () => {
      cancelled = true
    }
  }, [histoVisible, histo, entry])

  useEffect(() => {
    if (histoVisible && histo && canvasRef.current) drawHistogram(canvasRef.current, histo)
  }, [histoVisible, histo])

  if (!infoVisible && !histoVisible) return null

  return (
    <div
      className={cn(
        'absolute left-2 z-20 w-[236px] rounded bg-black/70 p-2 text-[10px] leading-4 text-neutral-300 shadow-lg backdrop-blur-sm',
        offsetTop ? 'top-9' : 'top-2',
      )}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {infoVisible && (
        <>
          <div className="mb-0.5 truncate font-semibold text-neutral-100" title={entry.path}>
            {entry.name}
          </div>
          <div className="text-neutral-400">
            {meta ? `${meta.w} × ${meta.h}` : '…'} · {formatBytes(entry.size)} · {(zoom * 100).toFixed(0)}%
            {index !== undefined && index >= 0 && total ? ` · ${index + 1}/${total}` : ''}
          </div>
        </>
      )}

      {histoVisible && (
        <div className={cn(infoVisible && 'mt-1 border-t border-white/10 pt-1')}>
          {histo ? (
            <canvas ref={canvasRef} width={220} height={100} className="rounded bg-black/50" />
          ) : histo === null ? (
            <div className="text-neutral-500">直方图不可用</div>
          ) : (
            <div className="text-neutral-500">直方图计算中…</div>
          )}
        </div>
      )}

      {infoVisible && (
        <div className="mt-1 border-t border-white/10 pt-1">
          <ExifBlock exif={exif} />
        </div>
      )}
    </div>
  )
}
