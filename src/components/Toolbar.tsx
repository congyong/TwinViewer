import { useMemo } from 'react'
import {
  Aperture,
  ArrowUpDown,
  ChartColumn,
  CircleHelp,
  Columns2,
  FolderOpen,
  Grid3X3,
  Image as ImageIcon,
  Images,
  Info,
  Layers,
  ListFilter,
  PanelBottom,
  PanelLeft,
  RotateCw,
  Rows3,
  SkipForward,
  X,
} from 'lucide-react'
import { getExtension } from '@/lib/fs-provider'
import { useAppStore } from '@/store/appStore'
import type { CompareLayout, GridLayout, ResampleMode, SortKey } from '@/store/appStore'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

const RESAMPLE_ITEMS: { value: ResampleMode; label: string }[] = [
  { value: 'auto', label: '缩放算法：自动' },
  { value: 'nearest', label: '缩放算法：邻近' },
  { value: 'bilinear', label: '缩放算法：双线性*' },
  { value: 'bicubic', label: '缩放算法：双立方*' },
]

const GRID_LAYOUTS: { value: GridLayout; label: string }[] = [
  { value: 'auto', label: '自动布局' },
  { value: '1x2', label: '1 × 2' },
  { value: '2x1', label: '2 × 1' },
  { value: '2x2', label: '2 × 2' },
  { value: '3x2', label: '3 × 2' },
  { value: '2x3', label: '2 × 3' },
  { value: '3x3', label: '3 × 3' },
]

const SORT_ITEMS: { value: SortKey; label: string }[] = [
  { value: 'name', label: '按名称' },
  { value: 'lastModified', label: '按日期' },
  { value: 'size', label: '按大小' },
]

export function Toolbar() {
  const dir = useAppStore((s) => s.dir)
  const providerKind = useAppStore((s) => s.providerKind)
  const images = useAppStore((s) => s.images)
  const recursive = useAppStore((s) => s.recursive)
  const setRecursive = useAppStore((s) => s.setRecursive)
  const formatFilter = useAppStore((s) => s.formatFilter)
  const setFormatFilter = useAppStore((s) => s.setFormatFilter)
  const sortKey = useAppStore((s) => s.sortKey)
  const setSortKey = useAppStore((s) => s.setSortKey)
  const sortAsc = useAppStore((s) => s.sortAsc)
  const toggleSortAsc = useAppStore((s) => s.toggleSortAsc)
  const thumbSize = useAppStore((s) => s.thumbSize)
  const setThumbSize = useAppStore((s) => s.setThumbSize)
  const viewMode = useAppStore((s) => s.viewMode)
  const setViewMode = useAppStore((s) => s.setViewMode)
  const compareLayout = useAppStore((s) => s.compareLayout)
  const setCompareLayout = useAppStore((s) => s.setCompareLayout)
  const sync = useAppStore((s) => s.sync)
  const setSync = useAppStore((s) => s.setSync)
  const swapSlots = useAppStore((s) => s.swapSlots)
  const nextPair = useAppStore((s) => s.nextPair)
  const checked = useAppStore((s) => s.checked)
  const startCompareFromChecked = useAppStore((s) => s.startCompareFromChecked)
  const clearChecked = useAppStore((s) => s.clearChecked)
  const openDirectory = useAppStore((s) => s.openDirectory)
  const resample = useAppStore((s) => s.resample)
  const setResample = useAppStore((s) => s.setResample)
  const infoVisible = useAppStore((s) => s.infoVisible)
  const toggleInfo = useAppStore((s) => s.toggleInfo)
  const histoVisible = useAppStore((s) => s.histoVisible)
  const toggleHisto = useAppStore((s) => s.toggleHisto)
  const gridLayout = useAppStore((s) => s.gridLayout)
  const setGridLayout = useAppStore((s) => s.setGridLayout)
  const gridSync = useAppStore((s) => s.gridSync)
  const setGridSync = useAppStore((s) => s.setGridSync)
  const nextBatch = useAppStore((s) => s.nextBatch)
  const resetView = useAppStore((s) => s.resetView)
  const rotateCurrent = useAppStore((s) => s.rotateCurrent)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const toggleFilmstrip = useAppStore((s) => s.toggleFilmstrip)
  const toggleHelp = useAppStore((s) => s.toggleHelp)

  const count = checked.length

  const extensions = useMemo(
    () =>
      [...new Set(images.map((e) => getExtension(e.name)).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [images],
  )

  return (
    <div className="flex select-none flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-[#242424] px-3 py-2">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-sky-400">
        <Aperture className="h-4 w-4" /> TwinView
      </div>
      <Button size="sm" variant="secondary" className="h-7 gap-1" onClick={() => void openDirectory()}>
        <FolderOpen className="h-3.5 w-3.5" /> 打开文件夹
      </Button>
      <span className="max-w-56 truncate text-xs text-neutral-500" title={dir?.name}>
        {dir ? dir.name : '未打开文件夹'}
        {providerKind === 'browser' && dir ? ' (浏览器)' : ''}
        {images.length > 0 && ` · ${images.length} 张`}
      </span>
      <label className="flex cursor-pointer items-center gap-1.5 text-xs text-neutral-300">
        <Switch checked={recursive} onCheckedChange={setRecursive} className="scale-90" /> 含子文件夹
      </label>

      <div className="h-4 w-px bg-neutral-700" />

      <ListFilter className="h-3.5 w-3.5 text-neutral-500" />
      <Select value={formatFilter} onValueChange={setFormatFilter}>
        <SelectTrigger className="h-7 w-24 text-xs" title="格式过滤">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all" className="text-xs">全部格式</SelectItem>
          {extensions.map((ext) => (
            <SelectItem key={ext} value={ext} className="text-xs">
              .{ext}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
        <SelectTrigger className="h-7 w-24 text-xs" title="排序方式">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORT_ITEMS.map((s) => (
            <SelectItem key={s.value} value={s.value} className="text-xs">
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0"
        title={sortAsc ? '升序（点击切换）' : '降序（点击切换）'}
        onClick={toggleSortAsc}
      >
        <ArrowUpDown className="h-3.5 w-3.5" />
      </Button>
      {viewMode === 'browse' && (
        <input
          type="range"
          min={96}
          max={320}
          step={8}
          value={thumbSize}
          onChange={(e) => setThumbSize(Number(e.target.value))}
          className="h-7 w-24 accent-sky-500"
          title="缩略图大小"
        />
      )}

      <div className="h-4 w-px bg-neutral-700" />

      {/* 视图模式：A/B 对比不设专门入口，由勾选 ≥2 张后「对比选中」或 A/B 键进入 */}
      <ToggleGroup
        type="single"
        value={viewMode === 'browse' || viewMode === 'single' ? viewMode : ''}
        onValueChange={(v) => {
          if (v === 'browse' || v === 'single') setViewMode(v)
        }}
        className="gap-0"
      >
        <ToggleGroupItem value="browse" className="h-7 gap-1 px-2 text-xs" title="缩略图浏览">
          <Rows3 className="h-3.5 w-3.5" /> 浏览
        </ToggleGroupItem>
        <ToggleGroupItem value="single" className="h-7 gap-1 px-2 text-xs" title="单图查看">
          <ImageIcon className="h-3.5 w-3.5" /> 单图
        </ToggleGroupItem>
      </ToggleGroup>

      {viewMode === 'compare' && (
        <>
          <ToggleGroup
            type="single"
            value={compareLayout}
            onValueChange={(v) => {
              if (v) setCompareLayout(v as CompareLayout)
            }}
            className="gap-0"
          >
            <ToggleGroupItem value="wipe" className="h-7 gap-1 px-2 text-xs" title="划变 (W 循环)">
              <Columns2 className="h-3.5 w-3.5 rotate-90" /> 划变
            </ToggleGroupItem>
            <ToggleGroupItem value="side" className="h-7 gap-1 px-2 text-xs" title="并排 (W 循环)">
              <Columns2 className="h-3.5 w-3.5" /> 并排
            </ToggleGroupItem>
            <ToggleGroupItem value="overlay" className="h-7 gap-1 px-2 text-xs" title="叠化 (W 循环)">
              <Layers className="h-3.5 w-3.5" /> 叠化
            </ToggleGroupItem>
          </ToggleGroup>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-neutral-300" title="同步：两侧共享缩放平移（并排模式）">
            <Switch checked={sync} onCheckedChange={setSync} className="scale-90" /> 同步
          </label>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" title="交换 A/B (X)" onClick={swapSlots}>
            交换
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" title="下一对 (N，仅勾选导航且勾选 ≥ 4 张)" onClick={nextPair}>
            下一对
          </Button>
        </>
      )}

      {(viewMode === 'single' || viewMode === 'compare' || viewMode === 'grid') && (
        <>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" title="适应窗口" onClick={() => resetView('fit')}>
            适应
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" title="实际大小 100% (1)" onClick={() => resetView('actual')}>
            1:1
          </Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="顺时针旋转 90° (R)" onClick={() => rotateCurrent(1)}>
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
        </>
      )}

      {viewMode === 'grid' && (
        <>
          <Select value={gridLayout} onValueChange={(v) => setGridLayout(v as GridLayout)}>
            <SelectTrigger className="h-7 w-24 text-xs" title="网格布局">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GRID_LAYOUTS.map((l) => (
                <SelectItem key={l.value} value={l.value} className="text-xs">
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-neutral-300" title="同步：所有格子共享缩放平移；独立：每格各自调整">
            <Switch checked={gridSync} onCheckedChange={setGridSync} className="scale-90" />
            {gridSync ? '同步' : '独立'}
          </label>
          <Button size="sm" variant="secondary" className="h-7 gap-1 text-xs" title="下一组 (N)" onClick={nextBatch}>
            <SkipForward className="h-3.5 w-3.5" /> 下一组
          </Button>
        </>
      )}

      <Button
        size="sm"
        variant={count >= 2 ? 'default' : 'secondary'}
        className="h-7 gap-1"
        disabled={count < 2}
        title={count >= 3 ? '多图网格对比（勾选 ≥ 3 张）' : 'A/B 对比（勾选 2 张）'}
        onClick={startCompareFromChecked}
      >
        {count >= 3 ? <Grid3X3 className="h-3.5 w-3.5" /> : <Images className="h-3.5 w-3.5" />}
        对比选中{count > 0 ? ` (${count})` : ''}
      </Button>
      {count > 0 && (
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="清除勾选" onClick={clearChecked}>
          <X className="h-3.5 w-3.5" />
        </Button>
      )}

      <div className="flex-1" />

      <Select value={resample} onValueChange={(v) => setResample(v as ResampleMode)}>
        <SelectTrigger className="h-7 w-40 text-xs" title="全局缩放重采样算法（* 双线性 / 双立方为 Canvas 平滑近似，持久化保存）">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RESAMPLE_ITEMS.map((r) => (
            <SelectItem key={r.value} value={r.value} className="text-xs">
              {r.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant={infoVisible ? 'secondary' : 'ghost'}
        className="h-7 w-7 p-0"
        title="信息浮层（基本 + EXIF）(I)"
        onClick={toggleInfo}
      >
        <Info className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="sm"
        variant={histoVisible ? 'secondary' : 'ghost'}
        className="h-7 w-7 p-0"
        title="直方图（带值域刻度，与信息浮层独立；状态持久化）"
        onClick={toggleHisto}
      >
        <ChartColumn className="h-3.5 w-3.5" />
      </Button>
      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="侧栏" onClick={toggleSidebar}>
        <PanelLeft className="h-3.5 w-3.5" />
      </Button>
      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="胶片条" onClick={toggleFilmstrip}>
        <PanelBottom className="h-3.5 w-3.5" />
      </Button>
      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="快捷键帮助 (?)" onClick={toggleHelp}>
        <CircleHelp className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
