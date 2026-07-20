import { useEffect, useRef, useState } from 'react'
import { Maximize2, Minimize2, X } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { cn } from '@/lib/utils'

/**
 * 单格全屏（控件内全屏）顶部迷你条：
 * 槽位标签 + 文件名 + 物理全屏切换（Shift+F）+ 退出全屏（Esc / F / 双击）
 *
 * 物理全屏下改为**悬浮半透明**样式（黑底 40% + 毛玻璃 + 圆角胶囊）：
 * 默认自动隐藏；鼠标移到屏幕顶部（≤24px）淡入，移开 1.5s 后淡出；
 * 计时器在退出物理全屏 / 组件卸载时统一清理。控件内全屏维持原常显样式。
 * （黑底浮层两主题通用，文字固定浅色）
 */
export function FullscreenMiniBar({
  label,
  labelClass,
  name,
  onExit,
}: {
  label?: string
  labelClass?: string
  name: string
  onExit: () => void
}) {
  const physical = useAppStore((s) => s.physicalFullscreen)
  const togglePhysical = useAppStore((s) => s.togglePhysicalFullscreen)
  const [hoverShow, setHoverShow] = useState(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearHideTimer = () => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }
  const scheduleHide = () => {
    clearHideTimer()
    hideTimerRef.current = setTimeout(() => setHoverShow(false), 1500)
  }

  // 物理全屏：顶部热区感应显隐；退出物理全屏时清理计时器并恢复常显
  useEffect(() => {
    if (!physical) {
      clearHideTimer()
      setHoverShow(false)
      return
    }
    const onMove = (e: MouseEvent) => {
      if (e.clientY <= 24) {
        clearHideTimer()
        setHoverShow(true)
      } else {
        scheduleHide()
      }
    }
    window.addEventListener('mousemove', onMove)
    return () => {
      window.removeEventListener('mousemove', onMove)
      clearHideTimer()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [physical])

  const floating = physical

  return (
    <div
      className={cn(
        'absolute left-1/2 top-2 z-30 flex -translate-x-1/2 items-center gap-2 text-xs text-neutral-200',
        floating
          ? cn(
              'rounded-full border border-white/15 bg-black/40 px-4 py-1.5 shadow-xl backdrop-blur-md',
              'transition-all duration-200',
              hoverShow ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-2 opacity-0',
            )
          : 'rounded bg-black/70 px-3 py-1 shadow',
      )}
      onMouseEnter={() => {
        if (floating) {
          clearHideTimer()
          setHoverShow(true)
        }
      }}
      onMouseLeave={() => {
        if (floating) scheduleHide()
      }}
    >
      {label && <span className={cn('font-bold', labelClass)}>{label}</span>}
      <span className="max-w-[36vw] truncate">{name}</span>
      <button
        className="ml-1 flex items-center gap-1 rounded bg-white/10 px-2 py-0.5 hover:bg-white/20"
        onClick={() => void togglePhysical()}
        title="物理全屏：隐藏浏览器 / 系统窗口边框 (Shift+F)"
      >
        {physical ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        {physical ? '退出物理全屏' : '物理全屏'}
      </button>
      <button
        className="flex items-center gap-1 rounded bg-white/10 px-2 py-0.5 hover:bg-white/20"
        onClick={onExit}
        title="退出全屏（Esc / F / 双击）"
      >
        <X className="h-3.5 w-3.5" /> 退出全屏
      </button>
    </div>
  )
}
