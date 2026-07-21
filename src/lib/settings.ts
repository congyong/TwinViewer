/**
 * 用户设置持久化（收口模块）：
 * - localStorage 单 key `twinview.settings` 存 `{ version, values }` JSON
 * - 版本号 + 迁移兜底：无新 key 时从旧散 key（twinview.favorites 等）一次性迁移；
 *   未来结构变更按 version 逐级迁移；损坏/手改内容经 sanitize 回落默认值
 * - appStore 全部用户可切换偏好统一经 `loadSettings()` 初始化、`updateSettings()` 写入
 */

export type ThemeMode = 'dark' | 'light' | 'system'
export type BrowseMode = 'large' | 'medium' | 'small' | 'list'
export type SortKey = 'name' | 'lastModified' | 'size'
export type ResampleMode = 'auto' | 'nearest' | 'bifant' | 'bilinear' | 'bicubic' | 'lanczos'
export type CompareLayout = 'wipe' | 'side' | 'overlay' | 'diff'
export type NavScope = 'all' | 'checked'
/** 差值热图 colormap */
export type DiffColormap = 'inferno' | 'gray' | 'viridis' | 'coolwarm'
/** 录制格式（开录前配置，持久化上次选择） */
export type RecFormat = 'video' | 'gif'
import type { RecQuality } from '@/lib/recorder'
export type { RecQuality }

export interface FavoriteEntry {
  path: string
  addedAt: number
}

export interface SettingsData {
  /** 含子文件夹（首次默认 false，见任务 5） */
  recursive: boolean
  formatFilter: string
  sortKey: SortKey
  sortAsc: boolean
  browseMode: BrowseMode
  navScope: NavScope
  compareLayout: CompareLayout
  /** A/B 并排同步 */
  sync: boolean
  /** 多图网格同步 */
  gridSync: boolean
  resample: ResampleMode
  histoVisible: boolean
  infoVisible: boolean
  theme: ThemeMode
  sidebarOpen: boolean
  filmstripOpen: boolean
  splitRatio: number
  wipeRatio: number
  overlayOpacity: number
  /** 差值热图 colormap */
  diffColormap: DiffColormap
  /** 差值容差 0–128（≤容差的像素置黑） */
  diffTolerance: number
  /** 录制格式（开录前配置对话框默认取上次选择） */
  recFormat: RecFormat
  /** 录制画质档（视频码率于录制开始确定；GIF 影响色数与缩放） */
  recQuality: RecQuality
  favorites: FavoriteEntry[]
}

export const SETTINGS_KEY = 'twinview.settings'
const SETTINGS_VERSION = 1

export const DEFAULT_SETTINGS: SettingsData = {
  recursive: false,
  formatFilter: 'all',
  sortKey: 'name',
  sortAsc: true,
  browseMode: 'medium',
  navScope: 'checked',
  compareLayout: 'side',
  sync: true,
  gridSync: true,
  resample: 'auto',
  histoVisible: false,
  infoVisible: true,
  theme: 'dark',
  sidebarOpen: true,
  filmstripOpen: true,
  splitRatio: 0.5,
  wipeRatio: 0.5,
  overlayOpacity: 0.5,
  diffColormap: 'inferno',
  diffTolerance: 16,
  recFormat: 'video',
  recQuality: 'medium',
  favorites: [],
}

/** 旧版散 key（v0 迁移来源） */
const LEGACY = {
  favorites: 'twinview.favorites',
  splitRatio: 'twinview.splitRatio',
  wipeRatio: 'twinview.wipeRatio',
  resample: 'twinview.resample',
  navScope: 'twinview.navScope',
  compareLayout: 'twinview.compareLayout',
  histoVisible: 'twinview.histoVisible',
  browseMode: 'twinview.browseMode',
} as const

const RESAMPLE_VALUES: ResampleMode[] = ['auto', 'nearest', 'bifant', 'bilinear', 'bicubic', 'lanczos']
const BROWSE_VALUES: BrowseMode[] = ['large', 'medium', 'small', 'list']
const SORT_VALUES: SortKey[] = ['name', 'lastModified', 'size']
const LAYOUT_VALUES: CompareLayout[] = ['wipe', 'side', 'overlay', 'diff']
/** 差值热图 colormap 可选值（顺序即下拉顺序：四种必需色带在前，单一来源供设置校验/工具栏/冒烟共用） */
export const DIFF_COLORMAP_VALUES: DiffColormap[] = ['inferno', 'gray', 'viridis', 'coolwarm']
const REC_FORMAT_VALUES: RecFormat[] = ['video', 'gif']
const REC_QUALITY_VALUES: RecQuality[] = ['high', 'medium', 'low']
const THEME_VALUES: ThemeMode[] = ['dark', 'light', 'system']

function clamp01(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function pick<T extends string>(v: unknown, allowed: T[], fallback: T): T {
  return typeof v === 'string' && (allowed as string[]).includes(v) ? (v as T) : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function ratio(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n < 1 ? clamp01(n, min, max) : fallback
}

/** 逐字段校验（防手改 localStorage 后运行时崩溃） */
function sanitize(raw: Partial<SettingsData>): SettingsData {
  const d = DEFAULT_SETTINGS
  return {
    recursive: bool(raw.recursive, d.recursive),
    formatFilter: typeof raw.formatFilter === 'string' && raw.formatFilter ? raw.formatFilter : d.formatFilter,
    sortKey: pick(raw.sortKey, SORT_VALUES, d.sortKey),
    sortAsc: bool(raw.sortAsc, d.sortAsc),
    browseMode: pick(raw.browseMode, BROWSE_VALUES, d.browseMode),
    navScope: raw.navScope === 'all' ? 'all' : 'checked',
    compareLayout: pick(raw.compareLayout, LAYOUT_VALUES, d.compareLayout),
    sync: bool(raw.sync, d.sync),
    gridSync: bool(raw.gridSync, d.gridSync),
    resample: pick(raw.resample, RESAMPLE_VALUES, d.resample),
    histoVisible: bool(raw.histoVisible, d.histoVisible),
    infoVisible: bool(raw.infoVisible, d.infoVisible),
    theme: pick(raw.theme, THEME_VALUES, d.theme),
    sidebarOpen: bool(raw.sidebarOpen, d.sidebarOpen),
    filmstripOpen: bool(raw.filmstripOpen, d.filmstripOpen),
    splitRatio: ratio(raw.splitRatio, d.splitRatio, 0.15, 0.85),
    wipeRatio: ratio(raw.wipeRatio, d.wipeRatio, 0.02, 0.98),
    overlayOpacity: ratio(raw.overlayOpacity, d.overlayOpacity, 0, 1),
    diffColormap: pick(raw.diffColormap, DIFF_COLORMAP_VALUES, d.diffColormap),
    diffTolerance: (() => {
      const n = Number(raw.diffTolerance)
      return Number.isFinite(n) ? Math.min(128, Math.max(0, Math.round(n))) : d.diffTolerance
    })(),
    recFormat: pick(raw.recFormat, REC_FORMAT_VALUES, d.recFormat),
    recQuality: pick(raw.recQuality, REC_QUALITY_VALUES, d.recQuality),
    favorites: Array.isArray(raw.favorites)
      ? raw.favorites.filter(
          (f): f is FavoriteEntry =>
            !!f && typeof f === 'object' && typeof (f as FavoriteEntry).path === 'string' && !!(f as FavoriteEntry).path,
        )
      : d.favorites,
  }
}

/** 旧散 key 迁移（仅在无新 key 的首次启动执行一次） */
function migrateLegacy(): Partial<SettingsData> {
  const out: Partial<SettingsData> = {}
  try {
    const favs = localStorage.getItem(LEGACY.favorites)
    if (favs) out.favorites = JSON.parse(favs) as FavoriteEntry[]
    const split = Number(localStorage.getItem(LEGACY.splitRatio))
    if (Number.isFinite(split)) out.splitRatio = split
    const wipe = Number(localStorage.getItem(LEGACY.wipeRatio))
    if (Number.isFinite(wipe)) out.wipeRatio = wipe
    const resample = localStorage.getItem(LEGACY.resample)
    if (resample) out.resample = resample as ResampleMode
    if (localStorage.getItem(LEGACY.navScope) === 'all') out.navScope = 'all'
    const layout = localStorage.getItem(LEGACY.compareLayout)
    if (layout) out.compareLayout = layout as CompareLayout
    if (localStorage.getItem(LEGACY.histoVisible) === '1') out.histoVisible = true
    const browse = localStorage.getItem(LEGACY.browseMode)
    if (browse) out.browseMode = browse as BrowseMode
  } catch {
    /* 单项损坏忽略，sanitize 兜底 */
  }
  return out
}

let cached: SettingsData | null = null

/** 启动统一加载（模块内缓存，运行期始终有效） */
export function loadSettings(): SettingsData {
  if (cached) return cached
  let data: Partial<SettingsData> = {}
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { version?: number; values?: Partial<SettingsData> }
      data = parsed && typeof parsed === 'object' ? (parsed.values ?? {}) : {}
      // 未来：if (parsed.version < 2) { …逐级迁移… }
    } else {
      data = migrateLegacy()
    }
  } catch {
    /* JSON 损坏 → 默认值 */
  }
  cached = sanitize(data)
  return cached
}

/** 部分更新并持久化（每次写入全量 values，版本号随行） */
export function updateSettings(patch: Partial<SettingsData>): void {
  cached = { ...loadSettings(), ...patch }
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ version: SETTINGS_VERSION, values: cached }))
  } catch {
    /* 配额错误忽略 */
  }
}
