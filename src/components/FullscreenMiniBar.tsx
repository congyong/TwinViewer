import { Maximize2, Minimize2, X } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { cn } from '@/lib/utils'

/**
 * 单格全屏（控件内全屏）顶部迷你条：
 * 槽位标签 + 文件名 + 物理全屏切换（Shift+F）+ 退出全屏（Esc / F / 双击）
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

  return (
    <div className="absolute left-1/2 top-2 z-30 flex -translate-x-1/2 items-center gap-2 rounded bg-black/70 px-3 py-1 text-xs text-neutral-200 shadow">
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
