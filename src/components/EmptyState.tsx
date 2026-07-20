import { Columns2, FolderOpen, Image as ImageIcon, MousePointerClick } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/appStore'

export function EmptyState() {
  const openDirectory = useAppStore((s) => s.openDirectory)
  const providerKind = useAppStore((s) => s.providerKind)

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="flex items-center gap-3 text-neutral-200">
        <ImageIcon className="h-10 w-10 text-sky-500" />
        <div className="text-left">
          <h1 className="text-xl font-bold">TwinView 图片对比浏览器</h1>
          <p className="text-xs text-neutral-500">
            {providerKind === 'electron' ? '桌面模式 · 原生文件系统' : '浏览器模式 · 文件仅在本机读取，不会上传'}
          </p>
        </div>
      </div>

      <Button size="lg" onClick={() => void openDirectory()}>
        <FolderOpen className="mr-2 h-5 w-5" /> 打开图片文件夹
      </Button>

      <div className="grid max-w-2xl grid-cols-1 gap-3 text-left text-sm text-neutral-400 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-white/5 p-3">
          <MousePointerClick className="mb-1.5 h-5 w-5 text-sky-400" />
          <div className="mb-1 font-semibold text-neutral-200">1. 浏览</div>
          打开文件夹后浏览缩略图；支持递归子文件夹、格式过滤、排序与尺寸调节。双击进入单图，右键文件操作。
        </div>
        <div className="rounded-lg border border-border bg-white/5 p-3">
          <Columns2 className="mb-1.5 h-5 w-5 text-sky-400" />
          <div className="mb-1 font-semibold text-neutral-200">2. A/B 对比</div>
          勾选 2 张后点「对比选中」进行 A/B 对比；勾选 ≥ 3 张进入多图网格对比；看图时按 A / B 键放入对应槽位。
        </div>
        <div className="rounded-lg border border-border bg-white/5 p-3">
          <ImageIcon className="mb-1.5 h-5 w-5 text-sky-400" />
          <div className="mb-1 font-semibold text-neutral-200">3. 同步 / 叠加</div>
          并排模式默认同步缩放平移；叠加模式可滑动透明度做 onion-skin 对比。按 ? 查看全部快捷键。
        </div>
      </div>
    </div>
  )
}
