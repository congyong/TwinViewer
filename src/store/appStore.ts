/**
 * 全局状态（zustand）：
 * - 目录/图片列表、浏览视野（currentPath + recursive）、排序过滤、勾选与剪贴板
 * - 四种视图模式（浏览/单图/A-B 对比/网格）及其 transform、布局、同步状态
 * - 解码会话边界：打开目录 / 重扫 / 退出对比到浏览时清空解码缓存与探针缓存
 * - ALT 取样记录（samples，最多 10 条）与物理全屏状态（Fullscreen API）
 */
import { create } from 'zustand'
import type { DirectorySource, ImageEntry } from '@/lib/fs-provider'
import { getFSProvider, getExtension, isElectron } from '@/lib/fs-provider'
import type { DirNode } from '@/lib/dir-tree'
import { fsAccessChildren, fallbackChildren, absDirOf, isAbsPath, normalizeSlashes, scopeOk } from '@/lib/dir-tree'
import { clamp } from '@/lib/format'
import { clearDecodeSession, preloadDecode } from '@/lib/decode-cache'
import { clearProbeCache } from '@/lib/pixel-probe'

export type ViewMode = 'browse' | 'single' | 'compare' | 'grid'
/** 浏览网格显示模式：大 / 中 / 小图标三档固定尺寸 + 列表 */
export type BrowseMode = 'large' | 'medium' | 'small' | 'list'
export type SortKey = 'name' | 'lastModified' | 'size'
export type ResampleMode = 'auto' | 'nearest' | 'bilinear' | 'bicubic'
export type CompareLayout = 'wipe' | 'side' | 'overlay'
export type GridLayout = 'auto' | '1x2' | '2x1' | '2x2' | '3x2' | '2x3' | '3x3'
export type NavScope = 'all' | 'checked'
export type ProviderKind = 'browser' | 'electron'

/** 视图变换：mode=fit 适应窗口；free 时 zoom 为相对原图的缩放，panFX/panFY 为渲染尺寸的分数位移；rotation 角度制 */
export interface ViewTransform {
  mode: 'fit' | 'free'
  zoom: number
  panFX: number
  panFY: number
  rotation: number
}

export interface FavoriteItem {
  path: string
  addedAt: number
}

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

const FAVS_KEY = 'twinview.favorites'
const SPLIT_KEY = 'twinview.splitRatio'
const WIPE_KEY = 'twinview.wipeRatio'
const RESAMPLE_KEY = 'twinview.resample'
const NAVSCOPE_KEY = 'twinview.navScope'
const LAYOUT_KEY = 'twinview.compareLayout'
const HISTO_KEY = 'twinview.histoVisible'
const BROWSE_MODE_KEY = 'twinview.browseMode'

/** 浏览模式三档图标档对应的固定缩略图尺寸（列表档不修改 thumbSize） */
export const BROWSE_MODE_SIZE: Record<Exclude<BrowseMode, 'list'>, number> = {
  large: 256,
  medium: 168,
  small: 112,
}

function loadFavorites(): FavoriteItem[] {
  try {
    const raw = localStorage.getItem(FAVS_KEY)
    return raw ? (JSON.parse(raw) as FavoriteItem[]) : []
  } catch {
    return []
  }
}

/** 读取 (0,1) 区间的小数偏好；非法时返回默认值并按 [min,max] 夹取 */
function loadRatio(key: string, def: number, min: number, max: number): number {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v > 0 && v < 1 ? clamp(v, min, max) : def
  } catch {
    return def
  }
}

function savePref(key: string, value: string | number): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    /* 忽略配额错误 */
  }
}

function loadResample(): ResampleMode {
  try {
    const v = localStorage.getItem(RESAMPLE_KEY)
    return v === 'nearest' || v === 'bilinear' || v === 'bicubic' ? v : 'auto'
  } catch {
    return 'auto'
  }
}

function loadNavScope(): NavScope {
  try {
    return localStorage.getItem(NAVSCOPE_KEY) === 'all' ? 'all' : 'checked'
  } catch {
    return 'checked'
  }
}

function loadCompareLayout(): CompareLayout {
  try {
    const v = localStorage.getItem(LAYOUT_KEY)
    return v === 'wipe' || v === 'overlay' || v === 'side' ? v : 'side'
  } catch {
    return 'side'
  }
}

function loadHistoVisible(): boolean {
  try {
    return localStorage.getItem(HISTO_KEY) === '1'
  } catch {
    return false
  }
}

function loadBrowseMode(): BrowseMode {
  try {
    const v = localStorage.getItem(BROWSE_MODE_KEY)
    return v === 'large' || v === 'small' || v === 'list' ? v : 'medium'
  } catch {
    return 'medium'
  }
}

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
  fullscreenCell: string | null
  physicalFullscreen: boolean
  sidebarOpen: boolean
  filmstripOpen: boolean
  helpOpen: boolean
  favorites: FavoriteItem[]
  samples: SampleRecord[]
  singleTransform: ViewTransform
  sharedTransform: ViewTransform
  transformA: ViewTransform
  transformB: ViewTransform
  gridTransforms: Record<number, ViewTransform>

  openDirectory: () => Promise<void>
  openPath: (path: string) => Promise<void>
  rescan: () => Promise<void>
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
  togglePhysicalFullscreen: () => Promise<void>
  addSample: (s: Omit<SampleRecord, 'seq'>) => void
  clearSamples: () => void
  toggleSidebar: () => void
  toggleFilmstrip: () => void
  toggleHelp: () => void
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

/** 初始浏览模式（读一次 localStorage；列表档时 thumbSize 回退中档尺寸） */
const initialBrowseMode = loadBrowseMode()

export const useAppStore = create<AppState>()((set, get) => ({
  providerKind: getFSProvider().kind,
  dir: null,
  loading: false,
  loadError: null,
  recursive: true,
  images: [],
  currentPath: '',
  treeChildren: {},
  treeExpanded: { '': true },
  ancestors: [],
  formatFilter: 'all',
  sortKey: 'name',
  sortAsc: true,
  thumbSize: BROWSE_MODE_SIZE[initialBrowseMode === 'list' ? 'medium' : initialBrowseMode],
  browseMode: initialBrowseMode,
  checked: [],
  clipboard: [],
  viewMode: 'browse',
  currentId: null,
  slotA: null,
  slotB: null,
  activeSlot: 'A',
  navScope: loadNavScope(),
  compareLayout: loadCompareLayout(),
  sync: true,
  splitRatio: loadRatio(SPLIT_KEY, 0.5, 0.15, 0.85),
  wipeRatio: loadRatio(WIPE_KEY, 0.5, 0.05, 0.95),
  overlayOpacity: 0.5,
  overlaySwapped: false,
  gridIds: [],
  gridActiveIdx: 0,
  gridSync: true,
  gridLayout: 'auto',
  resample: loadResample(),
  infoVisible: true,
  histoVisible: loadHistoVisible(),
  fullscreenCell: null,
  physicalFullscreen: false,
  sidebarOpen: true,
  filmstripOpen: true,
  helpOpen: false,
  favorites: loadFavorites(),
  samples: [],
  singleTransform: newTransform(),
  sharedTransform: newTransform(),
  transformA: newTransform(),
  transformB: newTransform(),
  gridTransforms: {},

  openDirectory: async () => {
    const provider = getFSProvider()
    const dir = await provider.pickDirectory()
    if (!dir) return
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

  setRecursive: (v) => set({ recursive: v }),
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

  setFormatFilter: (v) => set({ formatFilter: v }),
  setSortKey: (v) => set({ sortKey: v }),
  toggleSortAsc: () => set((s) => ({ sortAsc: !s.sortAsc })),
  setThumbSize: (v) => set({ thumbSize: v }),

  setBrowseMode: (m) => {
    savePref(BROWSE_MODE_KEY, m)
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
    savePref(NAVSCOPE_KEY, v)
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
    if (s.viewMode === 'compare') {
      const cur = s.activeSlot === 'A' ? s.slotA : s.slotB
      set(s.activeSlot === 'A' ? { slotA: stepId(cur) } : { slotB: stepId(cur) })
    } else if (s.viewMode === 'single') {
      set({ currentId: stepId(s.currentId) })
    } else if (s.viewMode === 'grid' && s.gridIds.length > 0) {
      get().setGridCellImage(s.gridActiveIdx, stepId(s.gridIds[s.gridActiveIdx] ?? null))
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
    savePref(LAYOUT_KEY, l)
    set({ compareLayout: l })
  },

  cycleCompareLayout: () =>
    set((s) => {
      const next: CompareLayout = s.compareLayout === 'wipe' ? 'side' : s.compareLayout === 'side' ? 'overlay' : 'wipe'
      savePref(LAYOUT_KEY, next)
      return { compareLayout: next }
    }),

  setSync: (v) => set({ sync: v }),

  setSplitRatio: (v) => {
    const r = clamp(v, 0.15, 0.85)
    savePref(SPLIT_KEY, r)
    set({ splitRatio: r })
  },

  setWipeRatio: (v) => {
    const r = clamp(v, 0.02, 0.98)
    savePref(WIPE_KEY, r)
    set({ wipeRatio: r })
  },

  setOverlayOpacity: (v) => set({ overlayOpacity: clamp(v, 0, 1) }),
  toggleOverlaySwapped: () => set((s) => ({ overlaySwapped: !s.overlaySwapped })),

  setGridLayout: (v) => set({ gridLayout: v }),
  setGridSync: (v) => set({ gridSync: v }),
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
    savePref(RESAMPLE_KEY, v)
    set({ resample: v })
  },

  toggleInfo: () => set((s) => ({ infoVisible: !s.infoVisible })),

  toggleHisto: () =>
    set((s) => {
      const v = !s.histoVisible
      savePref(HISTO_KEY, v ? '1' : '0')
      return { histoVisible: v }
    }),

  setFullscreenCell: (cell) => set({ fullscreenCell: cell }),

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

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleFilmstrip: () => set((s) => ({ filmstripOpen: !s.filmstripOpen })),
  toggleHelp: () => set((s) => ({ helpOpen: !s.helpOpen })),

  addFavorite: () => {
    const { dir, favorites } = get()
    if (!dir?.dirPath || favorites.some((f) => f.path === dir.dirPath)) return
    const next = [...favorites, { path: dir.dirPath, addedAt: Date.now() }]
    savePref(FAVS_KEY, JSON.stringify(next))
    set({ favorites: next })
  },

  removeFavorite: (path) => {
    const next = get().favorites.filter((f) => f.path !== path)
    savePref(FAVS_KEY, JSON.stringify(next))
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

// 仅开发模式暴露 store 句柄（Electron 冒烟测试 / 控制台调试；生产构建由 Rollup 消除）
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__twinviewStore = useAppStore
}

/** Electron 主进程桥可用性（调试/展示用） */
export function runningInElectron(): boolean {
  return isElectron()
}
