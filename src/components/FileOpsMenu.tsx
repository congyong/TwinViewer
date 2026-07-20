import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface MenuItem {
  icon?: ReactNode
  label: string
  danger?: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
}

/** 轻量自绘右键菜单（点击外部 / Esc / 失焦关闭，自动边界收拢） */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const width = 190
  const itemH = 30
  const left = Math.max(4, Math.min(x, window.innerWidth - width - 8))
  const top = Math.max(4, Math.min(y, window.innerHeight - items.length * itemH - 12))

  return (
    <div
      ref={ref}
      className="fixed z-[90] w-[190px] rounded-md border border-neutral-600 bg-[#2b2b2b] py-1 shadow-2xl"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => (
        <button
          key={i}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs',
            it.disabled
              ? 'cursor-not-allowed text-neutral-600'
              : it.danger
                ? 'text-red-400 hover:bg-red-500/15'
                : 'text-neutral-200 hover:bg-sky-600/30',
          )}
          disabled={it.disabled}
          title={it.title}
          onClick={() => {
            if (it.disabled) return
            onClose()
            it.onClick()
          }}
        >
          <span className="flex w-3.5 shrink-0 items-center justify-center">{it.icon}</span>
          <span className="flex-1 truncate">{it.label}</span>
        </button>
      ))}
    </div>
  )
}

/** 命名输入对话框（新建文件夹） */
export function NameDialog({
  title,
  placeholder = '文件夹名称',
  submitLabel = '确定',
  onSubmit,
  onClose,
}: {
  title: string
  placeholder?: string
  submitLabel?: string
  onSubmit: (name: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState('')
  const submit = () => {
    if (value.trim()) onSubmit(value.trim())
  }
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-80 rounded-lg border border-border bg-[#2a2a2a] p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-neutral-100">{title}</h3>
          <button className="text-neutral-500 hover:text-neutral-200" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onClose()
          }}
          className="mb-3 w-full rounded border border-neutral-600 bg-[#1c1c1c] px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-sky-500"
          placeholder={placeholder}
        />
        <div className="flex justify-end gap-2">
          <button className="rounded px-3 py-1 text-xs text-neutral-300 hover:bg-white/10" onClick={onClose}>
            取消
          </button>
          <button
            className="rounded bg-sky-600 px-3 py-1 text-xs text-white hover:bg-sky-500 disabled:opacity-40"
            disabled={!value.trim()}
            onClick={submit}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 确认对话框（删除等危险操作） */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = '确定',
  danger,
  onConfirm,
  onClose,
}: {
  title: string
  body: ReactNode
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-96 rounded-lg border border-border bg-[#2a2a2a] p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-2 text-sm font-semibold text-neutral-100">{title}</h3>
        <div className="mb-4 max-h-48 overflow-y-auto text-xs leading-5 text-neutral-300">{body}</div>
        <div className="flex justify-end gap-2">
          <button className="rounded px-3 py-1 text-xs text-neutral-300 hover:bg-white/10" onClick={onClose}>
            取消
          </button>
          <button
            className={cn(
              'rounded px-3 py-1 text-xs text-white',
              danger ? 'bg-red-600 hover:bg-red-500' : 'bg-sky-600 hover:bg-sky-500',
            )}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
