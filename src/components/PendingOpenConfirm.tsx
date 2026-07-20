/**
 * 浏览器模式「打开确认」：FS Access 限制下无法在选择文件夹前预览，
 * 故选择后立即扫描并弹出本确认条（前 12 张缩略图 + 总数），
 * 可「确认打开 / 重新选择 / 取消」。
 */
import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { useAppStore } from '@/store/appStore'

export function PendingOpenConfirm() {
  const pending = useAppStore((s) => s.pendingOpen)
  const confirmPendingOpen = useAppStore((s) => s.confirmPendingOpen)
  const discardPendingOpen = useAppStore((s) => s.discardPendingOpen)
  const [thumbs, setThumbs] = useState<{ id: string; url: string; name: string }[]>([])

  useEffect(() => {
    if (!pending) {
      setThumbs([])
      return
    }
    let alive = true
    const first = pending.images.slice(0, 12)
    void Promise.all(
      first.map(async (e) => ({ id: e.id, name: e.name, url: await e.getUrl() })),
    ).then((t) => {
      if (alive) setThumbs(t)
    })
    return () => {
      alive = false
    }
  }, [pending])

  if (!pending) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => void discardPendingOpen(false)}>
      <div
        className="flex w-[560px] flex-col overflow-hidden rounded-lg border border-border bg-[var(--tv-overlay)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--tv-line)] px-4 py-2.5">
          <FolderOpen className="h-4 w-4 text-sky-400" />
          <h2 className="text-sm font-semibold text-[var(--tv-text)]">打开此文件夹？</h2>
          <span className="ml-auto max-w-[55%] truncate text-xs text-[var(--tv-text-faint)]" title={pending.dir.name}>
            {pending.dir.name}
          </span>
        </div>

        <div className="p-3">
          {pending.images.length === 0 ? (
            <div className="py-6 text-center text-xs text-[var(--tv-text-faint)]">该文件夹（含子文件夹）无图片</div>
          ) : (
            <>
              <div className="grid grid-cols-6 gap-2">
                {thumbs.map((t) => (
                  <div key={t.id} className="aspect-square overflow-hidden rounded bg-[var(--tv-well)]" title={t.name}>
                    <img src={t.url} alt={t.name} className="h-full w-full object-cover" loading="lazy" />
                  </div>
                ))}
              </div>
              <div className="pt-2 text-center text-xs text-[var(--tv-text-faint)]">共 {pending.images.length} 张图片</div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--tv-line)] px-4 py-2.5">
          <button
            className="rounded border border-[var(--tv-line)] px-3 py-1 text-xs text-[var(--tv-text)] hover:bg-[var(--tv-soft)]"
            onClick={() => void discardPendingOpen(false)}
          >
            取消
          </button>
          <button
            className="rounded border border-[var(--tv-line)] px-3 py-1 text-xs text-[var(--tv-text)] hover:bg-[var(--tv-soft)]"
            onClick={() => void discardPendingOpen(true)}
          >
            重新选择…
          </button>
          <button
            className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={pending.images.length === 0}
            onClick={confirmPendingOpen}
          >
            确认打开
          </button>
        </div>
      </div>
    </div>
  )
}
