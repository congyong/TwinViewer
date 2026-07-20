import { useAppStore } from '@/store/appStore'

const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: '← / → 或 PgUp / PgDn', desc: '上一张 / 下一张（按当前导航范围循环）。单图：切当前图；对比：切**激活槽位**的图（优先跳过另一槽占据项，无其他项时允许与另一槽同图）；网格：切激活格（优先跳过其他格占据项，无其他项时同样允许同图）' },
  { keys: 'R / L', desc: '向右 / 向左旋转 90°（仅视图层，不修改文件）' },
  { keys: 'F', desc: '单图 / 对比激活格 / 网格当前格 = 进入或退出该格控件全屏（与双击链第一层同一状态）' },
  { keys: 'Shift+F', desc: '物理全屏（隐藏浏览器 / 窗口边框）：作用于当前视图整体，自动带悬浮迷你条' },
  { keys: 'Alt（按住）', desc: '颜色探针：浮签显示原图坐标与 RGB；ALT+单击记录到侧栏取样列表' },
  { keys: '1', desc: '实际大小 100%（单图 / 对比）；网格中为激活第 1 格' },
  { keys: '1 – 9', desc: '网格模式：激活第 N 格' },
  { keys: '双击图片', desc: '单图：适应窗口 ↔ 100%；对比 / 网格：三层链 —— 控件全屏 → 物理全屏 → 循环切换显示源（对比 A↔B / 网格下一格，槽位与格组内容不变）' },
  { keys: 'Esc', desc: '物理全屏 → 控件全屏 → 返回浏览模式（逐级退出）' },
  { keys: '滚轮', desc: '以鼠标为中心缩放' },
  { keys: '拖拽', desc: '平移图片' },
  { keys: 'I', desc: '显示 / 隐藏信息浮层（基本 + EXIF；直方图由工具栏独立开关）' },
  { keys: '空格', desc: '勾选 / 取消勾选当前图片' },
  { keys: 'Backspace', desc: '浏览模式：返回上级文件夹（与面包屑 / 文件夹树状态一致）' },
  { keys: '双击文件夹', desc: '进入该文件夹（网格 / 列表中文件夹排在图片前，带预览拼贴与计数）' },
  { keys: 'A / B', desc: '浏览 / 单图：把当前图片设为 A / B 槽；对比：选定激活侧' },
  { keys: 'Tab', desc: '对比：切换激活侧（A ↔ B）；网格：循环激活格' },
  { keys: 'X', desc: '交换 A/B' },
  { keys: 'W / G', desc: '循环对比布局（划变 → 并排 → 叠化）' },
  { keys: 'D', desc: '差值热图开关：逐像素差值 + colormap（inferno/gray/viridis/coolwarm）+ 容差 0–128（≤容差置黑），再按 D 返回之前布局' },
  { keys: 'N', desc: '对比：下一对（仅勾选导航且勾选 ≥4 张）；网格：下一组' },
  { keys: '?', desc: '打开 / 关闭本帮助' },
]

export function HelpOverlay() {
  const open = useAppStore((s) => s.helpOpen)
  const toggle = useAppStore((s) => s.toggleHelp)
  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={toggle}
    >
      <div
        className="max-h-[80vh] w-[560px] overflow-y-auto rounded-lg border border-border bg-[var(--tv-overlay)] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-base font-semibold text-[var(--tv-text)]">快捷键</h2>
        <table className="w-full text-sm">
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.keys} className="border-b border-[var(--tv-line)] last:border-0">
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <kbd className="rounded bg-black/50 px-1.5 py-0.5 text-xs text-sky-300">{s.keys}</kbd>
                </td>
                <td className="py-1.5 text-[var(--tv-text)]">{s.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-[var(--tv-text-faint)]">
          多图网格对比：浏览模式勾选 ≥ 3 张后点「对比选中」（勾选 2 张为 A/B 对比）。点击任意处或按 Esc / ? 关闭
        </p>
      </div>
    </div>
  )
}
