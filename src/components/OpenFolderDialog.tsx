/**
 * Electron 自绘「打开文件夹」对话框（简化选择流程）：
 * 左栏快捷入口（桌面/图片/文档/下载/盘符）+ 当前层子目录列表（含 ↑ 上级），
 * 右栏所选文件夹的图片预览（递归计数 + 前 12 张缩略图）。
 * 交互：**单击选中**子文件夹（高亮 + 预览），**双击进入**；「打开此文件夹」对
 * 选中项（无选中则当前位置）直接生效，无二次确认。底栏保留系统对话框入口
 * （win32 文件/文件夹均可选；选中文件 = 打开所在文件夹并定位选中）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, FolderOpen, HardDrive, Loader2, Star } from 'lucide-react'
import { getFSProvider, type BrowseDirResult, type DirImagePreview } from '@/lib/fs-provider'
import { FolderIcon } from '@/components/FolderIcon'
import { useAppStore } from '@/store/appStore'
import { cn } from '@/lib/utils'

function thumbUrl(path: string) {
  return `twinview://local/${encodeURIComponent(path)}`
}

export function OpenFolderDialog() {
  const open = useAppStore((s) => s.openFolderDialogOpen)
  const setOpen = useAppStore((s) => s.setOpenFolderDialog)
  const openPathFocus = useAppStore((s) => s.openPathFocus)
  const currentDirPath = useAppStore((s) => s.dir?.dirPath ?? null)

  const [specials, setSpecials] = useState<{ name: string; path: string }[]>([])
  const [browse, setBrowse] = useState<BrowseDirResult | null>(null)
  const [current, setCurrent] = useState<string | null>(null) // 当前浏览位置（null=顶层盘符）
  const [selected, setSelected] = useState<string | null>(null) // 单击选中的子文件夹
  const [preview, setPreview] = useState<DirImagePreview | null>(null)
  const [previewFor, setPreviewFor] = useState<string | null>(null)
  const [loadingDirs, setLoadingDirs] = useState(false)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const reqRef = useRef(0)

  const provider = getFSProvider()

  const doBrowse = useCallback(
    async (dir: string | null) => {
      if (!provider.browseDir) return
      const req = ++reqRef.current
      setLoadingDirs(true)
      try {
        const r = await provider.browseDir(dir)
        if (reqRef.current !== req) return
        setBrowse(r)
        setCurrent(r.path)
        setSelected(null) // 进入新位置即清空选中
      } finally {
        if (reqRef.current === req) setLoadingDirs(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // 打开时初始化：快捷入口 + 默认落在当前已打开文件夹（无则「图片」/ 顶层）
  useEffect(() => {
    if (!open) return
    let alive = true
    setPreview(null)
    setPreviewFor(null)
    void (async () => {
      const sp = (await provider.specialDirs?.().catch(() => [])) ?? []
      if (!alive) return
      setSpecials(sp)
      const fallback = sp.find((s) => s.name === '图片') ?? sp[0]
      await doBrowse(currentDirPath ?? (fallback ? fallback.path : null))
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 预览/打开目标：选中的子文件夹优先，否则当前浏览位置
  const target = selected ?? current

  // 目标变化 → 刷新预览
  useEffect(() => {
    if (!open || !target) {
      setPreview(null)
      setPreviewFor(null)
      return
    }
    let alive = true
    setLoadingPreview(true)
    void provider
      .dirImagePreview?.(target, 12)
      .then((p) => {
        if (!alive || !p) return
        setPreview(p)
        setPreviewFor(target)
      })
      .finally(() => {
        if (alive) setLoadingPreview(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target])

  if (!open) return null

  const close = () => setOpen(false)
  const openTarget = () => {
    if (!target || !preview || preview.count === 0) return
    setOpen(false)
    void openPathFocus(target)
  }
  const systemPick = async () => {
    setOpen(false)
    const dir = await provider.pickDirectory()
    if (!dir?.dirPath) return
    // 系统选择器选中文件时 focusFile 存在：打开所在文件夹并定位选中
    await openPathFocus(dir.dirPath, dir.focusFile)
  }

  const previewReady = preview && previewFor === target

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={close}>
      <div
        className="flex h-[480px] w-[720px] flex-col overflow-hidden rounded-lg border border-border bg-[var(--tv-overlay)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--tv-line)] px-4 py-2.5">
          <FolderOpen className="h-4 w-4 text-sky-400" />
          <h2 className="text-sm font-semibold text-[var(--tv-text)]">打开文件夹</h2>
          <span className="ml-auto max-w-[60%] truncate text-xs text-[var(--tv-text-faint)]" title={target ?? ''}>
            {target ?? '选择位置'}
          </span>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左栏：快捷入口 + 子目录 */}
          <div className="flex w-[300px] flex-col border-r border-[var(--tv-line)]">
            {specials.length > 0 && (
              <div className="border-b border-[var(--tv-line)] p-1.5">
                {specials.map((s) => (
                  <button
                    key={s.path || s.name}
                    className={cn(
                      'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-[var(--tv-soft)]',
                      current === s.path && !selected && 'bg-[var(--tv-soft)] text-sky-400',
                    )}
                    onClick={() => void doBrowse(s.path || null)}
                    title={s.path || '此电脑'}
                  >
                    {s.path ? <Star className="h-3.5 w-3.5 shrink-0 text-amber-500" /> : <HardDrive className="h-3.5 w-3.5 shrink-0 text-neutral-400" />}
                    <span className="truncate text-[var(--tv-text)]">{s.name}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {browse?.parent !== undefined && browse !== null && (browse.parent !== null || browse.path !== null) && (
                <button
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-[var(--tv-soft)]"
                  onClick={() => void doBrowse(browse.parent)}
                >
                  <ArrowUp className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                  <span className="text-[var(--tv-text)]">↑ 上级</span>
                </button>
              )}
              {loadingDirs && (
                <div className="flex items-center gap-2 px-2 py-2 text-xs text-[var(--tv-text-faint)]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> 读取中…
                </div>
              )}
              {!loadingDirs && browse?.dirs.length === 0 && (
                <div className="px-2 py-2 text-xs text-[var(--tv-text-faint)]">（无子文件夹）</div>
              )}
              {browse?.dirs.map((d) => (
                <button
                  key={d.path}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-[var(--tv-soft)]',
                    selected === d.path && 'bg-sky-600/20 text-sky-400',
                  )}
                  onClick={() => setSelected(d.path)}
                  onDoubleClick={() => void doBrowse(d.path)}
                  title={`${d.path}（单击选中，双击进入）`}
                >
                  <FolderIcon className="h-4 w-5 shrink-0" />
                  <span className="truncate text-[var(--tv-text)]">{d.name}</span>
                  {d.imageCount > 0 && <span className="ml-auto shrink-0 text-[10px] text-[var(--tv-text-faint)]">{d.imageCount}</span>}
                </button>
              ))}
            </div>
          </div>

          {/* 右栏：预览 */}
          <div className="flex min-w-0 flex-1 flex-col p-3">
            {loadingPreview && (
              <div className="flex flex-1 items-center justify-center gap-2 text-xs text-[var(--tv-text-faint)]">
                <Loader2 className="h-4 w-4 animate-spin" /> 统计图片中…
              </div>
            )}
            {!loadingPreview && !previewReady && (
              <div className="flex flex-1 items-center justify-center text-xs text-[var(--tv-text-faint)]">
                {target ? '该文件夹无图片' : '请选择文件夹'}
              </div>
            )}
            {!loadingPreview && previewReady && (
              <>
                {preview.count === 0 ? (
                  <div className="flex flex-1 items-center justify-center text-xs text-[var(--tv-text-faint)]">该文件夹（含子文件夹）无图片</div>
                ) : (
                  <>
                    <div className="grid flex-1 grid-cols-4 content-start gap-2 overflow-y-auto">
                      {preview.images.map((im) => (
                        <div key={im.path} className="aspect-square overflow-hidden rounded bg-[var(--tv-well)]" title={im.name}>
                          <img src={thumbUrl(im.path)} alt={im.name} className="h-full w-full object-cover" loading="lazy" />
                        </div>
                      ))}
                    </div>
                    <div className="pt-2 text-center text-xs text-[var(--tv-text-faint)]">
                      共 {preview.count}
                      {preview.capped ? '+' : ''} 张图片
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--tv-line)] px-4 py-2.5">
          <button className="rounded border border-[var(--tv-line)] px-2.5 py-1 text-xs text-[var(--tv-text)] hover:bg-[var(--tv-soft)]" onClick={() => void systemPick()}>
            系统对话框选择…
          </button>
          <div className="ml-auto flex gap-2">
            <button className="rounded border border-[var(--tv-line)] px-3 py-1 text-xs text-[var(--tv-text)] hover:bg-[var(--tv-soft)]" onClick={close}>
              取消
            </button>
            <button
              className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!target || !previewReady || preview.count === 0}
              onClick={openTarget}
            >
              打开此文件夹
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
