/**
 * 全局状态（zustand）：
 * - 目录/图片列表、浏览视野（currentPath + recursive）、排序过滤、勾选与剪贴板
 * - 四种视图模式（浏览/单图/A-B 对比/网格）及其 transform、布局、同步状态
 * - 解码会话边界：打开目录 / 重扫 / 退出对比到浏览时清空解码缓存与探针缓存
 * - ALT 取样记录（samples，最多 10 条）与物理全屏状态（Fullscreen API）
 */
import { create } from 'zustand'
import type { CliOpenPayload, DirectorySource, ImageEntry } from '@/lib/fs-provider'
import { getFSProvider, getExtension, isElectron } from '@/lib/fs-provider'
import type { DirNode } from '@/lib/dir-tree'
import { fsAccessChildren, fallbackChildren, absDirOf, isAbsPath, normalizeSlashes, scopeOk } from '@/lib/dir-tree'
import { clamp } from '@/lib/format'
import { clearDecodeSession, preloadDecode } from '@/lib/decode-cache'
import { clearProbeCache } from '@/lib/pixel-probe'
import { loadSettings, updateSettings } from '@/lib/settings'
import type {
  BrowseMode,
  CompareLayout,
  DiffColormap,
  FavoriteEntry,
  NavScope,
  RecFormat,
  ResampleMode,
  SortKey,
  ThemeMode,
} from '@/lib/settings'
import { applyTheme } from '@/lib/theme'
import {
  clearSession,
  discardCapture,
  encodeGif,
  gifFrameCount,
  startCapture,
  stopCapture,
  REC_MAX_SECONDS,
  type RecQuality,
} from '@/lib/recorder'

export type ViewMode = 'browse' | 'single' | 'compare' | 'grid'
export type { BrowseMode, CompareLayout, DiffColormap, NavScope, RecFormat, ResampleMode, SortKey, ThemeMode }
export type { RecQuality } from '@/lib/recorder'
export type GridLayout = 'auto' | '1x2' | '2x1' | '2x2' | '3x2' | '2x3' | '3x3'
export type ProviderKind = 'browser' | 'electron'

/** 视图变换：mode=fit 适应窗口；free 时 zoom 为相对原图的缩放，panFX/panFY 为渲染尺寸的分数位移；rotation 角度制 */
export interface ViewTransform {
  mode: 'fit' | 'free'
  zoom: number
  panFX: number
  panFY: number
  rotation: number
}

export interface FavoriteItem extends FavoriteEntry {}

/** 一条 ALT 取样记录（seq 由 store 分配，单调递增） */
export interface SampleRecord {
  seq: number
  slot: string
  name: string
  x: number
  y: number
  r: number
  g: number
  b: number
  a: number
}

const MAX_SAMPLES = 10

/** 新视图变换（适应窗口、无位移、未旋转） */
export const newTransform = (): ViewTransform => ({
  mode: 'fit',
  zoom: 1,
  panFX: 0,
  panFY: 0,
  rotation: 0,
})

/** 视野过滤 + 排序的查询参数（组件从 store 摘取后传入） */
export interface VisibleQuery {
  images: ImageEntry[]
  dir: DirectorySource | null
  currentPath: string
  recursive: boolean
  formatFilter: string
  sortKey: SortKey
  sortAsc: boolean
}

export interface NavQuery extends VisibleQuery {
  navScope: NavScope
  checked: string[]
}

/** 当前视野内（目录 + 递归开关 + 格式过滤）排序后的图片列表 */
export function getVisibleImages(q: VisibleQuery): ImageEntry[] {
  let list = q.images.filter((e) => scopeOk(e, q.dir, q.currentPath, q.recursive))
  if (q.formatFilter !== 'all') list = list.filter((e) => getExtension(e.name) === q.formatFilter)
  const sorted = [...list]
  const cmp = (a: ImageEntry, b: ImageEntry): number => {
    switch (q.sortKey) {
      case 'name':
        return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
      case 'size':
        return a.size - b.size
      case 'lastModified':
        return a.lastModified - b.lastModified
    }
  }
  sorted.sort(cmp)
  return q.sortAsc ? sorted : sorted.reverse()
}

/** 导航列表：视野列表按导航范围（全部 / 仅勾选）过滤 */
export function getNavList(q: NavQuery): ImageEntry[] {
  const vis = getVisibleImages(q)
  if (q.navScope === 'checked') {
    const set = new Set(q.checked)
    return vis.filter((e) => set.has(e.id))
  }
  return vis
}

/* ------------------------------ 持久化 ------------------------------ */

/** 浏览模式三档图标档对应的固定缩略图尺寸（列表档不修改 thumbSize） */
export const BROWSE_MODE_SIZE: Record<Exclude<BrowseMode, 'list'>, number> = {
  large: 256,
  medium: 168,
  small: 112,
}

/**
 * 启动时统一加载的用户设置（lib/settings.ts：单 key + 版本号 + 旧散 key 迁移）。
 * 所有偏好 setter 经 updateSettings() 持久化。
 */
const settings = loadSettings()

/** 打开目录 / 重扫时的状态重置（保留排序、过滤、布局等用户偏好） */
function freshState(dir: DirectorySource, images: ImageEntry[]) {
  return {
    dir,
    images,
    loading: false as boolean,
    checked: [] as string[],
    currentId: null as string | null,
    slotA: null as string | null,
    slotB: null as string | null,
    activeSlot: 'A' as 'A' | 'B',
    viewMode: 'browse' as ViewMode,
    currentPath: '',
    treeChildren: {} as Record<string, DirNode[]>,
    treeExpanded: { '': true } as Record<string, boolean>,
    ancestors: [] as DirNode[],
    gridIds: [] as string[],
    gridActiveIdx: 0,
    fullscreenCell: null as string | null,
    singleTransform: newTransform(),
    sharedTransform: newTransform(),
    transformA: newTransform(),
    transformB: newTransform(),
    gridTransforms: {} as Record<number, ViewTransform>,
  }
}

/** 预解码当前视图上下文涉及的图片（单图含前后邻居） */
function preloadCurrentContext(s: AppState): void {
  const byId = new Map(s.images.map((e) => [e.id, e]))
  const pick = (id: string | null | undefined): ImageEntry[] => {
    if (!id) return []
    const e = byId.get(id)
    return e ? [e] : []
  }
  let list: ImageEntry[] = []
  if (s.viewMode === 'compare') {
    list = [...pick(s.slotA), ...pick(s.slotB)]
  } else if (s.viewMode === 'grid') {
    list = s.gridIds.flatMap((id) => pick(id))
  } else if (s.viewMode === 'single') {
    const nav = getNavList(s)
    const idx = nav.findIndex((e) => e.id === s.currentId)
    list = pick(s.currentId)
    if (idx > 0) list.push(nav[idx - 1])
    if (idx >= 0 && idx < nav.length - 1) list.push(nav[idx + 1])
  }
  if (list.length > 0) void preloadDecode(list)
}

export interface AppState {
  providerKind: ProviderKind
  dir: DirectorySource | null
  loading: boolean
  loadError: string | null
  /** Electron：自绘「打开文件夹」对话框显隐 */
  openFolderDialogOpen: boolean
  /** 一次性操作提示（如对比导航无可切换项），3s 自动消失 */
  notice: string | null
  recursive: boolean
  images: ImageEntry[]
  currentPath: string
  treeChildren: Record<string, DirNode[]>
  treeExpanded: Record<string, boolean>
  ancestors: DirNode[]
  formatFilter: string
  sortKey: SortKey
  sortAsc: boolean
  thumbSize: number
  browseMode: BrowseMode
  checked: string[]
  clipboard: string[]
  viewMode: ViewMode
  currentId: string | null
  slotA: string | null
  slotB: string | null
  activeSlot: 'A' | 'B'
  navScope: NavScope
  compareLayout: CompareLayout
  sync: boolean
  splitRatio: number
  wipeRatio: number
  overlayOpacity: number
  overlaySwapped: boolean
  gridIds: string[]
  gridActiveIdx: number
  gridSync: boolean
  gridLayout: GridLayout
  resample: ResampleMode
  infoVisible: boolean
  histoVisible: boolean
  /** 控件内单格全屏标记：'single' | 'A' | 'B' | 网格格索引 string | null（双击链/F 进入；物理全屏可叠加其上） */
  fullscreenCell: string | null
  physicalFullscreen: boolean
  sidebarOpen: boolean
  filmstripOpen: boolean
  helpOpen: boolean
  favorites: FavoriteItem[]
  samples: SampleRecord[]
  theme: ThemeMode
  singleTransform: ViewTransform
  sharedTransform: ViewTransform
  transformA: ViewTransform
  transformB: ViewTransform
  gridTransforms: Record<number, ViewTransform>
  diffColormap: DiffColormap
  diffTolerance: number
  /** D 键切 diff 前的布局（退出 diff 时还原；会话级不持久化） */
  diffPrevLayout: CompareLayout
  /** 录制状态机：idle→configuring(开录前配置)→starting(倒计时)→recording→stopping(倒计时)→saving(系统保存对话框)→idle */
  recPhase: 'idle' | 'configuring' | 'starting' | 'recording' | 'stopping' | 'saving'
  recCountdown: number
  /** 录制进行秒数（徽标计时） */
  recElapsed: number
  /** 实际视频容器（'' = MediaRecorder 不可用，仅 GIF 可出） */
  recMime: string
  recBlob: Blob | null
  /** 开录前选择的格式/画质（持久化，取上次选择；保存阶段不再询问） */
  recFormat: RecFormat
  recQuality: RecQuality

  openDirectory: () => Promise<void>
  openPath: (path: string) => Promise<void>
  rescan: () => Promise<void>
  setOpenFolderDialog: (v: boolean) => void
  showNotice: (msg: string) => void
  /** 打开目录并（可选）按绝对路径定位选中某文件（系统选择器选中文件 / CLI 文件路径共用） */
  openPathFocus: (dirPath: string, focusFile?: string) => Promise<void>
  /** 主进程 CLI 下发（cli-open）：直接生效，不走任何确认弹窗 */
  applyCliOpen: (payload: CliOpenPayload) => Promise<void>
  setRecursive: (v: boolean) => void
  setCurrentPath: (path: string) => void
  toggleTreeNode: (relPath: string) => void
  loadTreeChildren: (relPath: string) => Promise<void>
  loadAncestors: () => Promise<void>
  setFormatFilter: (v: string) => void
  setSortKey: (v: SortKey) => void
  toggleSortAsc: () => void
  setThumbSize: (v: number) => void
  setBrowseMode: (m: BrowseMode) => void
  navigateUp: () => void
  toggleChecked: (id: string) => void
  checkAll: () => void
  clearChecked: () => void
  setClipboard: (ids: string[]) => void
  setViewMode: (m: ViewMode) => void
  setCurrent: (id: string | null) => void
  enterSingle: (id: string) => void
  startCompareFromChecked: () => void
  ensureSlots: () => void
  setSlot: (slot: 'A' | 'B', id: string | null) => void
  assignCurrentToSlot: (slot: 'A' | 'B') => void
  swapSlots: () => void
  toggleActiveSlot: () => void
  setNavScope: (v: NavScope) => void
  navigate: (delta: number) => void
  nextPair: () => void
  nextBatch: () => void
  reconcileNav: (prevIds: string[]) => void
  setCompareLayout: (l: CompareLayout) => void
  cycleCompareLayout: () => void
  /** D 键：进入差值布局 / 再按返回进入前的布局 */
  toggleDiffLayout: () => void
  setDiffColormap: (m: DiffColormap) => void
  setDiffTolerance: (v: number) => void
  /** S 键 / 工具栏按钮：idle→开录前配置；录制中→倒计时停止；倒计时内再按取消（configuring/saving 中 S 无效） */
  toggleRecord: () => void
  /** 配置对话框「开始录制」：确认格式/画质（已持久化）→ 进入 3 秒开始倒计时 */
  confirmRecConfig: () => void
  /** 配置对话框「取消」/ Esc：关闭对话框回 idle */
  cancelRecConfig: () => void
  beginCapture: () => Promise<void>
  finalizeCapture: () => Promise<void>
  setRecFormat: (f: RecFormat) => void
  setRecQuality: (q: RecQuality) => void
  saveRecording: () => Promise<void>
  cancelSave: () => void
  /** 视图切换 / 卸载：录制中一律停止并释放资源 */
  stopRecordingCleanup: () => void
  setSync: (v: boolean) => void
  setSplitRatio: (v: number) => void
  setWipeRatio: (v: number) => void
  setOverlayOpacity: (v: number) => void
  toggleOverlaySwapped: () => void
  setGridLayout: (v: GridLayout) => void
  setGridSync: (v: boolean) => void
  setGridActiveIdx: (i: number) => void
  setGridCellImage: (idx: number, id: string) => void
  setGridTransform: (idx: number, t: ViewTransform) => void
  setResample: (v: ResampleMode) => void
  toggleInfo: () => void
  toggleHisto: () => void
  setFullscreenCell: (cell: string | null) => void
  /** 双击三层交互链（对比/网格/单图控件全屏中）：L0→L1 控件全屏 → L2 物理全屏 → L3 循环切换显示源 */
  fullscreenDblClick: (cell: string) => void
  togglePhysicalFullscreen: () => Promise<void>
  addSample: (s: Omit<SampleRecord, 'seq'>) => void
  clearSamples: () => void
  toggleSidebar: () => void
  toggleFilmstrip: () => void
  toggleHelp: () => void
  setTheme: (m: ThemeMode) => void
  addFavorite: () => void
  removeFavorite: (path: string) => void
  setSingleTransform: (t: ViewTransform) => void
  setSharedTransform: (t: ViewTransform) => void
  setTransformA: (t: ViewTransform) => void
  setTransformB: (t: ViewTransform) => void
  rotateCurrent: (dir: 1 | -1) => void
  resetView: (mode: 'fit' | 'actual') => void
  revokeAll: () => void
}

/** showNotice 自动消失计时器（模块级单例） */
let noticeTimer: ReturnType<typeof setTimeout> | null = null

/** 录制：倒计时 tick / 计时徽标 / 时长上限计时器（模块级单例） */
let recTickTimer: ReturnType<typeof setInterval> | null = null
let recElapsedTimer: ReturnType<typeof setInterval> | null = null
let recMaxTimer: ReturnType<typeof setTimeout> | null = null

function clearRecTimers(): void {
  if (recTickTimer !== null) clearInterval(recTickTimer)
  if (recElapsedTimer !== null) clearInterval(recElapsedTimer)
  if (recMaxTimer !== null) clearTimeout(recMaxTimer)
  recTickTimer = null
  recElapsedTimer = null
  recMaxTimer = null
}

export const useAppStore = create<AppState>()((set, get) => ({
  providerKind: getFSProvider().kind,
  dir: null,
  loading: false,
  loadError: null,
  openFolderDialogOpen: false,
  notice: null,
  recursive: settings.recursive,
  images: [],
  currentPath: '',
  treeChildren: {},
  treeExpanded: { '': true },
  ancestors: [],
  formatFilter: settings.formatFilter,
  sortKey: settings.sortKey,
  sortAsc: settings.sortAsc,
  thumbSize: BROWSE_MODE_SIZE[settings.browseMode === 'list' ? 'medium' : settings.browseMode],
  browseMode: settings.browseMode,
  checked: [],
  clipboard: [],
  viewMode: 'browse',
  currentId: null,
  slotA: null,
  slotB: null,
  activeSlot: 'A',
  navScope: settings.navScope,
  compareLayout: settings.compareLayout,
  sync: settings.sync,
  splitRatio: clamp(settings.splitRatio, 0.15, 0.85),
  wipeRatio: clamp(settings.wipeRatio, 0.05, 0.95),
  overlayOpacity: settings.overlayOpacity,
  overlaySwapped: false,
  gridIds: [],
  gridActiveIdx: 0,
  gridSync: settings.gridSync,
  gridLayout: 'auto',
  resample: settings.resample,
  infoVisible: settings.infoVisible,
  histoVisible: settings.histoVisible,
  fullscreenCell: null,
  physicalFullscreen: false,
  sidebarOpen: settings.sidebarOpen,
  filmstripOpen: settings.filmstripOpen,
  helpOpen: false,
  favorites: settings.favorites,
  samples: [],
  theme: settings.theme,
  singleTransform: newTransform(),
  sharedTransform: newTransform(),
  transformA: newTransform(),
  transformB: newTransform(),
  gridTransforms: {},
  diffColormap: settings.diffColormap,
  diffTolerance: settings.diffTolerance,
  diffPrevLayout: settings.compareLayout === 'diff' ? 'side' : settings.compareLayout,
  recPhase: 'idle',
  recCountdown: 0,
  recElapsed: 0,
  recMime: '',
  recBlob: null,
  recFormat: settings.recFormat,
  recQuality: settings.recQuality,

  openDirectory: async () => {
    const provider = getFSProvider()
    // Electron：自绘带预览的「打开文件夹」对话框（内部保留系统对话框入口）
    if (provider.kind === 'electron') {
      set({ openFolderDialogOpen: true })
      return
    }
    const dir = await provider.pickDirectory()
    if (!dir) return
    // 浏览器模式：选择即打开（无二次确认）
    set({ loading: true, loadError: null })
    try {
      const images = await provider.listImages(dir, true)
      get().revokeAll()
      clearDecodeSession()
      clearProbeCache()
      set(freshState(dir, images))
      void get().loadAncestors()
    } catch (err) {
      set({ loading: false, loadError: err instanceof Error ? err.message : String(err) })
    }
  },

  setOpenFolderDialog: (v) => set({ openFolderDialogOpen: v }),

  showNotice: (msg) => {
    if (noticeTimer) clearTimeout(noticeTimer)
    set({ notice: msg })
    noticeTimer = setTimeout(() => set({ notice: null }), 3000)
  },

  openPathFocus: async (dirPath, focusFile) => {
    await get().openPath(dirPath)
    if (!focusFile) return
    const norm = normalizeSlashes(focusFile).toLowerCase()
    const hit = get().images.find((e) => normalizeSlashes(e.path).toLowerCase() === norm)
    if (hit) set({ currentId: hit.id })
  },

  applyCliOpen: async (payload) => {
    const provider = getFSProvider()
    if (provider.kind !== 'electron' || !provider.scanPath) return
    const { kind, paths, flags } = payload
    if (flags.theme) get().setTheme(flags.theme)
    if (flags.recursive) get().setRecursive(true)
    const norm = (x: string) => normalizeSlashes(x).toLowerCase()
    const findByPath = (p: string) => get().images.find((e) => norm(e.path) === norm(p))

    if (kind === 'folder') {
      const target = paths[0]
      if (!target) return
      // 文件 → 打开所在文件夹并定位选中；文件夹 → 直接打开
      if (payload.isFile) await get().openPathFocus(absDirOf(target), target)
      else await get().openPath(target)
      return
    }

    // --compare A B：打开共同（或 A 的）所在文件夹，A/B 入槽进对比
    const [a, b] = paths
    if (!a || !b) return
    const dirA = normalizeSlashes(absDirOf(a)).split('/')
    const dirB = normalizeSlashes(absDirOf(b)).split('/')
    const common: string[] = []
    for (let i = 0; i < Math.min(dirA.length, dirB.length); i++) {
      if (dirA[i].toLowerCase() !== dirB[i].toLowerCase()) break
      common.push(dirA[i])
    }
    await get().openPath(common.length > 0 ? common.join('/') : dirA.join('/'))
    const ea = findByPath(a)
    const eb = findByPath(b)
    if (!ea) {
      set({ loadError: `CLI 对比：在打开目录中找不到 ${a}` })
      return
    }
    if (!eb) console.warn(`[CLI] 对比图片 B 不在打开目录树下，仅设置 A 槽: ${b}`)
    set({ slotA: ea.id, slotB: eb?.id ?? null })
    if (flags.layout === 'grid') {
      set({
        gridIds: eb ? [ea.id, eb.id] : [ea.id],
        gridActiveIdx: 0,
        viewMode: 'grid',
        fullscreenCell: null,
        sharedTransform: newTransform(),
      })
    } else {
      if (flags.layout) get().setCompareLayout(flags.layout)
      if (!eb) get().ensureSlots()
      set({
        viewMode: 'compare',
        activeSlot: 'A',
        fullscreenCell: null,
        sharedTransform: newTransform(),
        transformA: newTransform(),
        transformB: newTransform(),
      })
    }
    preloadCurrentContext(get())
  },

  openPath: async (path) => {
    const provider = getFSProvider()
    if (!provider.scanPath) return
    set({ loading: true, loadError: null })
    try {
      const { dir, images } = await provider.scanPath(path, true)
      get().revokeAll()
      clearDecodeSession()
      clearProbeCache()
      set(freshState(dir, images))
      void get().loadAncestors()
    } catch (err) {
      set({ loading: false, loadError: err instanceof Error ? err.message : String(err) })
    }
  },

  rescan: async () => {
    const { dir } = get()
    if (!dir) return
    const provider = getFSProvider()
    set({ loading: true, loadError: null })
    try {
      const images = await provider.listImages(dir, true)
      get().revokeAll()
      clearDecodeSession()
      clearProbeCache()
      set({ ...freshState(dir, images) })
      void get().loadAncestors()
    } catch (err) {
      set({ loading: false, loadError: err instanceof Error ? err.message : String(err) })
    }
  },

  setRecursive: (v) => {
    updateSettings({ recursive: v })
    set({ recursive: v })
  },
  setCurrentPath: (path) => set({ currentPath: path }),

  toggleTreeNode: (relPath) => {
    const expanded = get().treeExpanded[relPath] ?? relPath === ''
    set((s) => ({ treeExpanded: { ...s.treeExpanded, [relPath]: !expanded } }))
    if (!expanded && get().treeChildren[relPath] === undefined) void get().loadTreeChildren(relPath)
  },

  loadTreeChildren: async (relPath) => {
    const { dir, images } = get()
    if (!dir) return
    const provider = getFSProvider()
    try {
      let nodes: DirNode[]
      if (provider.listDirs && (dir.dirPath || isAbsPath(relPath))) {
        // Electron：按层 IPC；relPath 为绝对路径（祖先链）时直接用，否则拼到根目录下
        const abs = isAbsPath(relPath)
          ? normalizeSlashes(relPath)
          : relPath === ''
            ? dir.dirPath
            : `${dir.dirPath}/${relPath}`
        const dirs = await provider.listDirs(abs ?? relPath)
        const rootNorm = dir.dirPath ? normalizeSlashes(dir.dirPath) : ''
        nodes = dirs.map((d) => {
          const norm = normalizeSlashes(d.path)
          return {
            name: d.name,
            relPath:
              rootNorm && norm === rootNorm ? '' : isAbsPath(relPath) ? norm : relPath === '' ? d.name : `${relPath}/${d.name}`,
            imageCount: d.imageCount,
            hasChildren: d.hasSubdirs,
          }
        })
      } else if (dir.handle && !isAbsPath(relPath)) {
        nodes = await fsAccessChildren(dir.handle, relPath)
      } else {
        nodes = fallbackChildren(images, dir, relPath)
      }
      set((s) => ({ treeChildren: { ...s.treeChildren, [relPath]: nodes } }))
    } catch {
      set((s) => ({ treeChildren: { ...s.treeChildren, [relPath]: [] } }))
    }
  },

  loadAncestors: async () => {
    const { dir } = get()
    const provider = getFSProvider()
    if (!dir?.dirPath || !provider.listAncestors) return
    try {
      const list = (await provider.listAncestors(dir.dirPath)).map((d) => ({
        name: d.name,
        relPath: normalizeSlashes(d.path),
        imageCount: d.imageCount,
        hasChildren: true,
      }))
      set({ ancestors: list })
    } catch {
      /* 祖先链不可用时忽略 */
    }
  },

  setFormatFilter: (v) => {
    updateSettings({ formatFilter: v })
    set({ formatFilter: v })
  },
  setSortKey: (v) => {
    updateSettings({ sortKey: v })
    set({ sortKey: v })
  },
  toggleSortAsc: () =>
    set((s) => {
      updateSettings({ sortAsc: !s.sortAsc })
      return { sortAsc: !s.sortAsc }
    }),
  setThumbSize: (v) => set({ thumbSize: v }),

  setBrowseMode: (m) => {
    updateSettings({ browseMode: m })
    // 图标档写入对应固定尺寸；列表档保留当前 thumbSize 以便切回
    if (m !== 'list') set({ browseMode: m, thumbSize: BROWSE_MODE_SIZE[m] })
    else set({ browseMode: m })
  },

  // 返回上级目录：相对路径逐段回退到根（''）；祖先链绝对路径逐级向上
  navigateUp: () => {
    const { currentPath } = get()
    if (!currentPath) return
    if (isAbsPath(currentPath)) {
      const parent = absDirOf(currentPath)
      if (normalizeSlashes(parent) !== normalizeSlashes(currentPath)) set({ currentPath: parent })
      return
    }
    const i = currentPath.lastIndexOf('/')
    set({ currentPath: i < 0 ? '' : currentPath.slice(0, i) })
  },

  toggleChecked: (id) =>
    set((s) => ({
      checked: s.checked.includes(id) ? s.checked.filter((x) => x !== id) : [...s.checked, id],
    })),
  checkAll: () => set((s) => ({ checked: getVisibleImages(s).map((e) => e.id) })),
  clearChecked: () => set({ checked: [] }),
  setClipboard: (ids) => set({ clipboard: ids }),

  setViewMode: (mode) => {
    const prev = get().viewMode
    get().stopRecordingCleanup() // 视图切换：录制中一律停止并释放
    if (mode === 'compare') get().ensureSlots()
    if (mode === 'single' && !get().currentId) {
      const nav = getNavList(get())
      if (nav.length > 0) set({ currentId: nav[0].id })
    }
    set({ viewMode: mode, fullscreenCell: null })
    // 退出对比会话：解码产物与探针缓存统一释放
    if (mode === 'browse' && (prev === 'compare' || prev === 'grid')) {
      clearDecodeSession()
      clearProbeCache()
    }
    preloadCurrentContext(get())
  },

  setCurrent: (id) => set({ currentId: id }),

  enterSingle: (id) => {
    set({ currentId: id, viewMode: 'single', singleTransform: newTransform() })
    preloadCurrentContext(get())
  },

  startCompareFromChecked: () => {
    const { checked } = get()
    if (checked.length === 2) {
      set({
        slotA: checked[0],
        slotB: checked[1],
        activeSlot: 'A',
        viewMode: 'compare',
        fullscreenCell: null,
        sharedTransform: newTransform(),
        transformA: newTransform(),
        transformB: newTransform(),
      })
    } else if (checked.length >= 3) {
      set({
        gridIds: checked.slice(0, 9),
        gridActiveIdx: 0,
        viewMode: 'grid',
        fullscreenCell: null,
        sharedTransform: newTransform(),
        gridTransforms: {},
      })
    }
    preloadCurrentContext(get())
  },

  ensureSlots: () => {
    const s = get()
    const nav = getNavList(s)
    if (nav.length === 0) return
    let { slotA, slotB, currentId } = s
    if (!slotA) slotA = currentId && nav.some((e) => e.id === currentId) ? currentId : nav[0].id
    if (!slotB || slotB === slotA) {
      const idx = nav.findIndex((e) => e.id === slotA)
      slotB = nav.length > 1 ? nav[(idx + 1) % nav.length].id : slotA
    }
    set({ slotA, slotB })
  },

  setSlot: (slot, id) => {
    set(slot === 'A' ? { slotA: id } : { slotB: id })
    preloadCurrentContext(get())
  },

  assignCurrentToSlot: (slot) => {
    const s = get()
    const src = s.viewMode === 'compare' ? (s.activeSlot === 'A' ? s.slotA : s.slotB) : s.currentId
    if (!src) return
    const patch: Partial<AppState> = slot === 'A' ? { slotA: src } : { slotB: src }
    if (s.viewMode === 'single') {
      // 单图指定第二槽：另一槽已有不同的图 → 直接进入对比并激活本槽
      const other = slot === 'A' ? s.slotB : s.slotA
      if (other && other !== src) {
        patch.viewMode = 'compare'
        patch.activeSlot = slot
      }
    }
    set(patch)
    preloadCurrentContext(get())
  },

  swapSlots: () =>
    set((s) => ({
      slotA: s.slotB,
      slotB: s.slotA,
      transformA: s.transformB,
      transformB: s.transformA,
      activeSlot: s.activeSlot === 'A' ? 'B' : 'A',
    })),

  toggleActiveSlot: () => set((s) => ({ activeSlot: s.activeSlot === 'A' ? 'B' : 'A' })),

  setNavScope: (v) => {
    updateSettings({ navScope: v })
    set({ navScope: v })
  },

  navigate: (delta) => {
    const s = get()
    const nav = getNavList(s)
    if (nav.length === 0) return
    const stepId = (id: string | null): string => {
      const idx = nav.findIndex((e) => e.id === id)
      if (idx < 0) return nav[delta >= 0 ? 0 : nav.length - 1].id
      return nav[(idx + delta + nav.length) % nav.length].id
    }
    /** 在导航集合内循环步进，跳过 skip 命中的项（如另一槽位/其他格占据的图）；无处可去返回原值 */
    const stepIdSkipping = (id: string | null, skip: (id: string) => boolean): string => {
      const len = nav.length
      const idx = nav.findIndex((e) => e.id === id)
      if (idx < 0) {
        let next = delta >= 0 ? 0 : len - 1
        for (let i = 0; i < len; i++) {
          if (!skip(nav[next].id)) return nav[next].id
          next = (next + delta + len) % len
        }
        return nav[delta >= 0 ? 0 : len - 1].id
      }
      let next = idx
      for (let i = 0; i < len; i++) {
        next = (next + delta + len) % len
        if (!skip(nav[next].id)) return nav[next].id
      }
      return nav[idx].id // 集合内除被占据项外无其他项：无处可去，保持
    }
    if (s.viewMode === 'compare') {
      // ←/→ 作用于**当前显示的槽位**：控件全屏（双击链 L1/L2/L3）= fullscreenCell 指定的槽
      // （X 交换会翻转 activeSlot，显示槽与激活槽错位时以显示为准，否则改了隐藏槽看似失效）；
      // 非全屏 = 激活槽位（Tab 切换）。优先跳过另一侧槽位占据的图；
      // 跳过后无目标时回退为不跳过（允许 A/B 同图）；集合仅 1 张且当前就在该图时静默 noop
      const target = s.fullscreenCell === 'A' || s.fullscreenCell === 'B' ? s.fullscreenCell : s.activeSlot
      const other = target === 'A' ? s.slotB : s.slotA
      const cur = target === 'A' ? s.slotA : s.slotB
      let next = stepIdSkipping(cur, (id) => id === other)
      if (next === cur) next = stepId(cur) // 回退：允许与另一槽重复
      if (next === cur) return
      set(target === 'A' ? { slotA: next } : { slotB: next })
    } else if (s.viewMode === 'single') {
      set({ currentId: stepId(s.currentId) })
    } else if (s.viewMode === 'grid' && s.gridIds.length > 0) {
      // ←/→ 作用于**当前显示的格**：控件全屏 = fullscreenCell 格索引（L3 切源后与 gridActiveIdx 错位时以显示为准）；
      // 非全屏 = 激活格（Tab/数字键切换）。优先跳过其他格占据的图；
      // 跳过后无目标时回退为不跳过（允许与其他格同图）；集合仅 1 张时静默 noop
      const fsIdx =
        s.fullscreenCell !== null && /^\d+$/.test(s.fullscreenCell) ? parseInt(s.fullscreenCell, 10) : -1
      const targetIdx = fsIdx >= 0 && fsIdx < s.gridIds.length ? fsIdx : s.gridActiveIdx
      const others = new Set(s.gridIds.filter((_, i) => i !== targetIdx))
      const cur = s.gridIds[targetIdx] ?? null
      let next = stepIdSkipping(cur, (id) => others.has(id))
      if (next === cur) next = stepId(cur) // 回退：允许与其他格重复
      if (next === cur) return
      // 直接写入而非 setGridCellImage：后者对「目标 id 已在其他格」做交换（胶片条指派的既有语义），
      // 回退同图场景必须允许重复；正常跳过路径下 next 不在 others 中，直接写入与 setGridCellImage 等价
      const gridIds = [...s.gridIds]
      gridIds[targetIdx] = next
      set({ gridIds })
      preloadCurrentContext(get())
      return
    }
    preloadCurrentContext(get())
  },

  nextPair: () => {
    const s = get()
    if (s.navScope !== 'checked' || s.checked.length < 4) return
    const nav = getNavList(s)
    if (nav.length < 4) return
    const ids = nav.map((e) => e.id)
    const cur = s.slotA ? ids.indexOf(s.slotA) : -1
    let next = cur < 0 ? 0 : cur + 2
    if (next >= ids.length) next = 0
    set({ slotA: ids[next], slotB: ids[(next + 1) % ids.length] })
    preloadCurrentContext(get())
  },

  nextBatch: () => {
    const s = get()
    if (s.viewMode !== 'grid' || s.gridIds.length === 0) return
    const n = s.gridIds.length
    const pool = s.checked.length >= n ? s.checked : getNavList(s).map((e) => e.id)
    if (pool.length === 0) return
    const cur = pool.indexOf(s.gridIds[0])
    const start = cur < 0 ? 0 : (cur + n) % pool.length
    const ids = Array.from({ length: Math.min(n, pool.length) }, (_, i) => pool[(start + i) % pool.length])
    set({ gridIds: ids, gridActiveIdx: 0, fullscreenCell: null })
    preloadCurrentContext(get())
  },

  reconcileNav: (prevIds) => {
    const s = get()
    const nav = getNavList(s)
    if (nav.length === 0) return
    const ids = nav.map((e) => e.id)
    const fix = (id: string | null): string | null => {
      if (!id || ids.includes(id)) return id
      const prevIdx = prevIds.indexOf(id)
      const at = prevIdx < 0 ? 0 : clamp(prevIdx, 0, ids.length - 1)
      return ids[at]
    }
    const currentId = fix(s.currentId)
    const slotA = fix(s.slotA)
    const slotB = fix(s.slotB)
    if (currentId !== s.currentId || slotA !== s.slotA || slotB !== s.slotB) {
      set({ currentId, slotA, slotB })
    }
  },

  setCompareLayout: (l) => {
    updateSettings({ compareLayout: l })
    // 从非 diff 布局手动切换（工具栏三档）时记录回退目标；切到 diff 不动 diffPrevLayout（由 toggleDiffLayout 管理）
    set((s) => (l !== 'diff' && s.compareLayout !== 'diff' ? { compareLayout: l, diffPrevLayout: l } : { compareLayout: l }))
  },

  cycleCompareLayout: () =>
    set((s) => {
      // W/G 只在 划变→并排→叠化 三档循环；diff 档时回到划变
      const next: CompareLayout =
        s.compareLayout === 'wipe' ? 'side' : s.compareLayout === 'side' ? 'overlay' : 'wipe'
      updateSettings({ compareLayout: next })
      return { compareLayout: next, diffPrevLayout: next }
    }),

  toggleDiffLayout: () =>
    set((s) => {
      if (s.compareLayout === 'diff') {
        const back = s.diffPrevLayout === 'diff' ? 'side' : s.diffPrevLayout
        updateSettings({ compareLayout: back })
        return { compareLayout: back }
      }
      updateSettings({ compareLayout: 'diff' })
      return { compareLayout: 'diff', diffPrevLayout: s.compareLayout }
    }),

  setDiffColormap: (m) => {
    updateSettings({ diffColormap: m })
    set({ diffColormap: m })
  },

  setDiffTolerance: (v) => {
    const t = Math.min(128, Math.max(0, Math.round(v)))
    updateSettings({ diffTolerance: t })
    set({ diffTolerance: t })
  },

  toggleRecord: () => {
    const phase = get().recPhase
    if (phase === 'idle') {
      // 先配置后开录：弹出开录前配置对话框（格式/画质，默认取上次选择）
      set({ recPhase: 'configuring' })
    } else if (phase === 'starting') {
      // 开始倒计时内取消
      clearRecTimers()
      set({ recPhase: 'idle', recCountdown: 0 })
    } else if (phase === 'recording') {
      // 停止倒计时（期间继续录；倒计时内再按 S 取消停止）
      if (recTickTimer !== null) clearInterval(recTickTimer)
      set({ recPhase: 'stopping', recCountdown: 3 })
      recTickTimer = setInterval(() => {
        const c = get().recCountdown
        if (c <= 1) {
          if (recTickTimer !== null) clearInterval(recTickTimer)
          recTickTimer = null
          void get().finalizeCapture()
        } else {
          set({ recCountdown: c - 1 })
        }
      }, 1000)
    } else if (phase === 'stopping') {
      // 取消停止 → 回到录制中
      if (recTickTimer !== null) clearInterval(recTickTimer)
      recTickTimer = null
      set({ recPhase: 'recording', recCountdown: 0 })
    }
    // configuring / saving 中 S 无效（对话框操作）
  },

  confirmRecConfig: () => {
    if (get().recPhase !== 'configuring') return
    // 开始倒计时（3s，叠显示区中央悬浮胶囊；倒计时内再按 S 取消）
    clearRecTimers()
    set({ recPhase: 'starting', recCountdown: 3 })
    recTickTimer = setInterval(() => {
      const c = get().recCountdown
      if (c <= 1) {
        if (recTickTimer !== null) clearInterval(recTickTimer)
        recTickTimer = null
        void get().beginCapture()
      } else {
        set({ recCountdown: c - 1 })
      }
    }, 1000)
  },

  cancelRecConfig: () => {
    if (get().recPhase !== 'configuring') return
    set({ recPhase: 'idle' })
  },

  beginCapture: async () => {
    try {
      const { mime } = await startCapture(get().recQuality)
      set({ recPhase: 'recording', recCountdown: 0, recMime: mime, recElapsed: 0 })
      recElapsedTimer = setInterval(() => set({ recElapsed: get().recElapsed + 1 }), 1000)
      recMaxTimer = setTimeout(() => {
        if (get().recPhase === 'recording' || get().recPhase === 'stopping') {
          get().showNotice('录制已达 10 分钟上限，自动停止')
          void get().finalizeCapture()
        }
      }, REC_MAX_SECONDS * 1000)
    } catch (err) {
      set({ recPhase: 'idle', recCountdown: 0 })
      get().showNotice(`录制启动失败：${err instanceof Error ? err.message : String(err)}`)
    }
  },

  finalizeCapture: async () => {
    if (recElapsedTimer !== null) clearInterval(recElapsedTimer)
    if (recMaxTimer !== null) clearTimeout(recMaxTimer)
    recElapsedTimer = null
    recMaxTimer = null
    const { blob, mime } = await stopCapture()
    if (blob || gifFrameCount() > 0) {
      set({ recPhase: 'saving', recBlob: blob, recMime: mime })
      // 停止后直接弹系统保存对话框选位置（格式/画质按开录前选择，不再询问）；
      // 用户取消路径选择则留在 saving，由叠层提供「重试保存 / 放弃录制」
      void get().saveRecording()
    } else {
      clearSession()
      set({ recPhase: 'idle', recBlob: null, recMime: '' })
      get().showNotice('录制无输出')
    }
  },

  setRecFormat: (f) => {
    updateSettings({ recFormat: f })
    set({ recFormat: f })
  },
  setRecQuality: (q) => {
    updateSettings({ recQuality: q })
    set({ recQuality: q })
  },

  saveRecording: async () => {
    const s = get()
    if (s.recPhase !== 'saving') return
    const isGif = s.recFormat === 'gif'
    try {
      let blob: Blob | null
      let ext: string
      if (isGif) {
        blob = await encodeGif(s.recQuality)
        ext = 'gif'
      } else {
        blob = s.recBlob
        ext = s.recMime.includes('mp4') ? 'mp4' : 'webm'
      }
      if (!blob) throw new Error('无视频输出（当前环境 MediaRecorder 不可用，可改选 GIF）')
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const name = `TwinView-${stamp}.${ext}`
      if (isElectron()) {
        const path = await window.twinview?.recSaveDialog?.(name, ext.toUpperCase(), ext)
        if (!path) return // 用户取消路径选择：留在 saving 可重选
        const r = await window.twinview?.writeBinaryFile?.(path, await blob.arrayBuffer())
        if (!r || !r.ok) throw new Error(r?.error ?? '写入失败')
        get().showNotice('录制已保存')
      } else {
        // 浏览器模式：只能触发下载（无法选保存位置）
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
        get().showNotice('已开始下载录制文件')
      }
      clearSession()
      set({ recPhase: 'idle', recBlob: null, recMime: '' })
    } catch (err) {
      get().showNotice(`保存失败：${err instanceof Error ? err.message : String(err)}`)
      // 留在 saving 允许换格式重试
    }
  },

  cancelSave: () => {
    discardCapture()
    clearSession()
    set({ recPhase: 'idle', recBlob: null, recMime: '', recCountdown: 0 })
  },

  stopRecordingCleanup: () => {
    if (get().recPhase === 'idle') return
    clearRecTimers()
    discardCapture()
    clearSession()
    set({ recPhase: 'idle', recCountdown: 0, recElapsed: 0, recBlob: null, recMime: '' })
  },

  setSync: (v) => {
    updateSettings({ sync: v })
    set({ sync: v })
  },

  setSplitRatio: (v) => {
    const r = clamp(v, 0.15, 0.85)
    updateSettings({ splitRatio: r })
    set({ splitRatio: r })
  },

  setWipeRatio: (v) => {
    const r = clamp(v, 0.02, 0.98)
    updateSettings({ wipeRatio: r })
    set({ wipeRatio: r })
  },

  setOverlayOpacity: (v) => {
    const r = clamp(v, 0, 1)
    updateSettings({ overlayOpacity: r })
    set({ overlayOpacity: r })
  },
  toggleOverlaySwapped: () => set((s) => ({ overlaySwapped: !s.overlaySwapped })),

  setGridLayout: (v) => set({ gridLayout: v }),
  setGridSync: (v) => {
    updateSettings({ gridSync: v })
    set({ gridSync: v })
  },
  setGridActiveIdx: (i) => set({ gridActiveIdx: i }),

  setGridCellImage: (idx, id) => {
    const ids = [...get().gridIds]
    if (idx < 0 || idx >= ids.length) return
    const existing = ids.indexOf(id)
    if (existing >= 0 && existing !== idx) ids[existing] = ids[idx]
    ids[idx] = id
    set({ gridIds: ids })
    preloadCurrentContext(get())
  },

  setGridTransform: (idx, t) => set((s) => ({ gridTransforms: { ...s.gridTransforms, [idx]: t } })),

  setResample: (v) => {
    updateSettings({ resample: v })
    set({ resample: v })
  },

  toggleInfo: () =>
    set((s) => {
      updateSettings({ infoVisible: !s.infoVisible })
      return { infoVisible: !s.infoVisible }
    }),

  toggleHisto: () =>
    set((s) => {
      const v = !s.histoVisible
      updateSettings({ histoVisible: v })
      return { histoVisible: v }
    }),

  setFullscreenCell: (cell) => set({ fullscreenCell: cell }),

  /**
   * 双击三层交互链（第九轮恢复，作用于被双击的视图格）：
   * L0 原布局 →（双击格 / F）→ L1 单格控件全屏（fullscreenCell=该格）
   * L1 →（双击）→ L2 物理全屏（Fullscreen API，fullscreenCell 保持）
   * L2 →（双击）→ L3 循环切换全屏显示源：对比 A↔B、网格下一格（**槽位/网格内容本身不变**，只改显示哪一格；单图无源可切，无操作）
   * Esc 逐层退回见 useKeyboard（physical → fullscreenCell → browse）。
   */
  fullscreenDblClick: (cell) => {
    const s = get()
    if (s.physicalFullscreen) {
      if (s.viewMode === 'compare') {
        set({ fullscreenCell: s.fullscreenCell === 'A' ? 'B' : 'A' })
      } else if (s.viewMode === 'grid' && s.gridIds.length > 0) {
        const cur = parseInt(s.fullscreenCell ?? '', 10)
        const base = Number.isNaN(cur) ? -1 : cur
        set({ fullscreenCell: String((base + 1) % s.gridIds.length) })
      }
      return
    }
    if (s.fullscreenCell) {
      void get().togglePhysicalFullscreen()
      return
    }
    set({ fullscreenCell: cell })
  },

  togglePhysicalFullscreen: async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch {
      /* 请求被拒绝等情况忽略；状态以 fullscreenchange 事件为准 */
    }
  },

  addSample: (sample) =>
    set((s) => {
      const seq = s.samples.length > 0 ? s.samples[s.samples.length - 1].seq + 1 : 1
      return { samples: [...s.samples.slice(-(MAX_SAMPLES - 1)), { ...sample, seq }] }
    }),
  clearSamples: () => set({ samples: [] }),

  toggleSidebar: () =>
    set((s) => {
      updateSettings({ sidebarOpen: !s.sidebarOpen })
      return { sidebarOpen: !s.sidebarOpen }
    }),
  toggleFilmstrip: () =>
    set((s) => {
      updateSettings({ filmstripOpen: !s.filmstripOpen })
      return { filmstripOpen: !s.filmstripOpen }
    }),
  toggleHelp: () => set((s) => ({ helpOpen: !s.helpOpen })),

  setTheme: (m) => {
    updateSettings({ theme: m })
    applyTheme(m)
    set({ theme: m })
  },

  addFavorite: () => {
    const { dir, favorites } = get()
    if (!dir?.dirPath || favorites.some((f) => f.path === dir.dirPath)) return
    const next = [...favorites, { path: dir.dirPath, addedAt: Date.now() }]
    updateSettings({ favorites: next })
    set({ favorites: next })
  },

  removeFavorite: (path) => {
    const next = get().favorites.filter((f) => f.path !== path)
    updateSettings({ favorites: next })
    set({ favorites: next })
  },

  setSingleTransform: (t) => set({ singleTransform: t }),
  setSharedTransform: (t) => set({ sharedTransform: t }),
  setTransformA: (t) => set({ transformA: t }),
  setTransformB: (t) => set({ transformB: t }),
  rotateCurrent: (dir) => {
    const s = get()
    const rot = (t: ViewTransform): ViewTransform => ({
      ...t,
      rotation: (((t.rotation + dir * 90) % 360) + 360) % 360,
    })
    if (s.viewMode === 'single') {
      set({ singleTransform: rot(s.singleTransform) })
    } else if (s.viewMode === 'compare') {
      if (s.sync || s.compareLayout !== 'side') set({ sharedTransform: rot(s.sharedTransform) })
      else if (s.activeSlot === 'A') set({ transformA: rot(s.transformA) })
      else set({ transformB: rot(s.transformB) })
    } else if (s.viewMode === 'grid') {
      if (s.gridSync) set({ sharedTransform: rot(s.sharedTransform) })
      else
        set({
          gridTransforms: {
            ...s.gridTransforms,
            [s.gridActiveIdx]: rot(s.gridTransforms[s.gridActiveIdx] ?? newTransform()),
          },
        })
    }
  },

  resetView: (mode) => {
    const s = get()
    const reset = (t: ViewTransform): ViewTransform =>
      mode === 'fit'
        ? { ...t, mode: 'fit', panFX: 0, panFY: 0 }
        : { ...t, mode: 'free', zoom: 1, panFX: 0, panFY: 0 }
    if (s.viewMode === 'single') {
      set({ singleTransform: reset(s.singleTransform) })
    } else if (s.viewMode === 'compare') {
      if (s.sync || s.compareLayout !== 'side') set({ sharedTransform: reset(s.sharedTransform) })
      else set({ transformA: reset(s.transformA), transformB: reset(s.transformB) })
    } else if (s.viewMode === 'grid') {
      if (s.gridSync) {
        set({ sharedTransform: reset(s.sharedTransform) })
      } else {
        const next: Record<number, ViewTransform> = {}
        for (const k of Object.keys(s.gridTransforms)) next[Number(k)] = reset(s.gridTransforms[Number(k)])
        for (let i = 0; i < s.gridIds.length; i++) next[i] = reset(next[i] ?? newTransform())
        set({ gridTransforms: next })
      }
    }
  },

  revokeAll: () => {
    for (const e of get().images) e.revoke()
  },
}))

// 启动时应用持久化主题（index.html 内联脚本负责首帧防闪，此处为 React 接管后的权威状态）
applyTheme(settings.theme)

// 仅开发模式暴露 store 句柄（Electron 冒烟测试 / 控制台调试；生产构建由 Rollup 消除）
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__twinviewStore = useAppStore
}

/** Electron 主进程桥可用性（调试/展示用） */
export function runningInElectron(): boolean {
  return isElectron()
}
