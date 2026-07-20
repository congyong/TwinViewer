import { useMemo } from 'react'
import type { ImageEntry } from '@/lib/fs-provider'
import { formatBytes } from '@/lib/format'

interface StatusBarProps {
  entry: ImageEntry | null
  meta: { w: number; h: number } | null
  zoom: number
  index: number
  total: number
  extra?: string
}

export function StatusBar({ entry, meta, zoom, index, total, extra }: StatusBarProps) {
  const text = useMemo(() => {
    if (!entry) return '无图片'
    const parts = [
      entry.name,
      meta ? `${meta.w} × ${meta.h} px` : '尺寸读取中…',
      formatBytes(entry.size),
      `缩放 ${(zoom * 100).toFixed(0)}%`,
      total > 0 ? `第 ${index + 1} / ${total} 张` : '',
    ]
    if (extra) parts.push(extra)
    return parts.filter(Boolean).join('　|　')
  }, [entry, meta, zoom, index, total, extra])

  return (
    <div className="shrink-0 truncate border-t border-border bg-[var(--tv-panel2)] px-3 py-1 text-xs text-[var(--tv-text-dim)]">
      {text}
    </div>
  )
}
