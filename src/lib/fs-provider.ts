/**
 * 文件系统抽象层
 * - BrowserFSProvider：优先 File System Access API（showDirectoryPicker），
 *   不支持时回退到 <input type="file" webkitdirectory>
 * - ElectronFSProvider：通过 preload 暴露的 window.twinview IPC 访问原生文件系统，
 *   图片通过主进程注册的 twinview:// 自定义协议提供（免拷贝、安全）
 */

export interface ImageEntry {
  id: string
  name: string
  /** 相对路径（浏览器）或绝对路径（Electron） */
  path: string
  size: number
  lastModified: number
  /** File System Access 模式的文件句柄（文件操作：复制来源 / 删除用） */
  handle?: FileSystemFileHandle
  /** 返回 blob: object URL 或 twinview:// URL */
  getUrl: () => Promise<string>
  /** 释放 object URL（Electron 下为空操作） */
  revoke: () => void
}

export interface DirectorySource {
  /** 展示用名称/路径 */
  name: string
  /** File System Access API 句柄 */
  handle?: FileSystemDirectoryHandle
  /** webkitdirectory 回退得到的文件列表 */
  files?: File[]
  /** Electron 下的绝对路径 */
  dirPath?: string
  /** Electron 系统选择器选中文件时：该文件绝对路径（打开所在文件夹后定位选中） */
  focusFile?: string
}

export interface FileOpFailure {
  name: string
  error: string
}

export interface FileOpResult {
  ok: string[]
  failed: FileOpFailure[]
}

export interface FSProvider {
  kind: 'browser' | 'electron'
  pickDirectory(): Promise<DirectorySource | null>
  listImages(dir: DirectorySource, recursive: boolean): Promise<ImageEntry[]>
  /** Electron 专用：订阅主进程 CLI 下发（cli-open），返回取消订阅函数 */
  onCliOpen?(cb: (payload: CliOpenPayload) => void): () => void
  /** Electron 专用：按路径直接扫描（用于收藏夹） */
  scanPath?(dirPath: string, recursive: boolean): Promise<{ dir: DirectorySource; images: ImageEntry[] }>
  /** Electron 专用：列出一层子目录（含本层图片数/是否有子目录） */
  listDirs?(absPath: string): Promise<DirInfo[]>
  /** Electron 专用：祖先链（root-first，不含自身） */
  listAncestors?(absPath: string): Promise<DirInfo[]>
  /** Electron 专用：读取文件字节（渲染进程创建 blob: URL 做解码/分析，避免 twinview:// 污染 canvas） */
  readFileBuffer?(absPath: string): Promise<Uint8Array | null>
  /** Electron 专用：复制文件到目标目录（重名自动加副本后缀） */
  copyFiles?(sources: string[], targetDir: string): Promise<FileOpResult>
  /** Electron 专用：新建文件夹 */
  makeDir?(parent: string, name: string): Promise<{ ok: boolean; error?: string }>
  /** Electron 专用：移入回收站（shell.trashItem） */
  trashItems?(paths: string[]): Promise<FileOpResult>
  /** Electron 专用：打开对话框快捷入口 */
  specialDirs?(): Promise<{ name: string; path: string }[]>
  /** Electron 专用：打开对话框列一层子目录（null = 顶层） */
  browseDir?(dir: string | null): Promise<BrowseDirResult>
  /** Electron 专用：目录图片预览（默认递归计数 + 前 limit 张；shallow=true 只列本层并附 dirs 子文件夹条目） */
  dirImagePreview?(dir: string, limit: number, shallow?: boolean): Promise<DirImagePreview>
  /** Electron 专用：拖放 File → 绝对路径 */
  getPathForFile?(file: File): string
  /** Electron 专用：拖放递归复制（重名自动副本） */
  copyInto?(sources: string[], targetDir: string): Promise<FileOpResult>
}

export interface BrowseDirResult {
  path: string | null
  parent: string | null
  dirs: DirInfo[]
}

/** 主进程 CLI 下发载荷（cli-open IPC） */
export interface CliOpenPayload {
  kind: 'folder' | 'compare'
  paths: string[]
  flags: {
    recursive?: boolean
    theme?: 'dark' | 'light' | 'system'
    layout?: 'wipe' | 'side' | 'overlay' | 'diff' | 'grid'
  }
  /** kind=folder 时：路径是文件（打开所在文件夹并定位选中） */
  isFile: boolean
}

export interface DirImagePreview {
  count: number
  capped: boolean
  images: { path: string; name: string }[]
  /** shallow 模式返回：本层子文件夹条目（名称+路径） */
  dirs?: { name: string; path: string }[]
}

export interface DirInfo {
  name: string
  path: string
  imageCount: number
  hasSubdirs: boolean
}

export const IMAGE_EXTENSIONS = [
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico', 'tif', 'tiff',
] as const

export function getExtension(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function isImageFile(name: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(getExtension(name))
}

interface ScannedFile {
  path: string
  name: string
  size: number
  lastModified: number
}

interface TwinviewBridge {
  selectDirectory(): Promise<{ path: string; isFile: boolean } | null>
  onCliOpen(cb: (payload: CliOpenPayload) => void): () => void
  scanDirectory(dir: string, recursive: boolean): Promise<ScannedFile[]>
  listDirs(dir: string): Promise<DirInfo[]>
  getAncestors(dir: string): Promise<DirInfo[]>
  readFileBuffer(path: string): Promise<Uint8Array | null>
  copyFiles(sources: string[], targetDir: string): Promise<FileOpResult>
  makeDir(parent: string, name: string): Promise<{ ok: boolean; error?: string }>
  trashItems(paths: string[]): Promise<FileOpResult>
  setWindowBackground?(color: string): Promise<void>
  specialDirs(): Promise<{ name: string; path: string }[]>
  browseDir(dir: string | null): Promise<BrowseDirResult>
  dirImagePreview(dir: string, limit: number, shallow?: boolean): Promise<DirImagePreview>
  getPathForFile(file: File): string
  copyInto(sources: string[], targetDir: string): Promise<FileOpResult>
  platform: string
  versions: Record<string, string>
}

declare global {
  interface Window {
    twinview?: TwinviewBridge
    showDirectoryPicker?: (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
  }
}

export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.twinview
}

/* ----------------------------- 浏览器实现 ----------------------------- */

function entryFromFile(file: File, path: string): ImageEntry {
  let url: string | null = null
  return {
    id: `${path}::${file.size}::${file.lastModified}`,
    name: file.name,
    path,
    size: file.size,
    lastModified: file.lastModified,
    async getUrl() {
      if (!url) url = URL.createObjectURL(file)
      return url
    },
    revoke() {
      if (url) {
        URL.revokeObjectURL(url)
        url = null
      }
    },
  }
}

function entryFromHandle(handle: FileSystemFileHandle, path: string, file: File): ImageEntry {
  let url: string | null = null
  return {
    id: `${path}::${file.size}::${file.lastModified}`,
    name: file.name,
    path,
    size: file.size,
    lastModified: file.lastModified,
    handle,
    async getUrl() {
      if (!url) url = URL.createObjectURL(await handle.getFile())
      return url
    },
    revoke() {
      if (url) {
        URL.revokeObjectURL(url)
        url = null
      }
    },
  }
}

async function walkHandle(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  recursive: boolean,
  out: ImageEntry[],
): Promise<void> {
  const iterable = (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()
  for await (const child of iterable) {
    if (child.kind === 'file') {
      if (!isImageFile(child.name)) continue
      const fh = child as FileSystemFileHandle
      const file = await fh.getFile()
      out.push(entryFromHandle(fh, prefix + child.name, file))
    } else if (recursive && child.kind === 'directory') {
      await walkHandle(child as FileSystemDirectoryHandle, `${prefix}${child.name}/`, true, out)
    }
  }
}

function pickViaInput(): Promise<DirectorySource | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.webkitdirectory = true
    input.multiple = true
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      if (files.length === 0) {
        resolve(null)
        return
      }
      const first = files[0] as File & { webkitRelativePath?: string }
      const root = (first.webkitRelativePath || '').split('/')[0] || '所选文件夹'
      resolve({ name: root, files })
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}

class BrowserFSProvider implements FSProvider {
  kind = 'browser' as const

  async pickDirectory(): Promise<DirectorySource | null> {
    if (window.showDirectoryPicker) {
      try {
        // 请求 readwrite：文件操作（复制/粘贴/新建/删除）需要写权限
        const handle = await window.showDirectoryPicker({ id: 'twinview-dir', mode: 'readwrite' })
        return { name: handle.name, handle }
      } catch {
        // 用户取消
        return null
      }
    }
    return pickViaInput()
  }

  async listImages(dir: DirectorySource, recursive: boolean): Promise<ImageEntry[]> {
    if (dir.handle) {
      const out: ImageEntry[] = []
      await walkHandle(dir.handle, '', recursive, out)
      return out
    }
    // webkitdirectory 回退：始终为递归结果，recursive=false 时仅保留顶层
    const files = dir.files ?? []
    return files
      .filter((f) => isImageFile(f.name))
      .filter((f) => {
        if (recursive) return true
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
        return rel.split('/').length <= 2
      })
      .map((f) => {
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
        return entryFromFile(f, rel)
      })
  }
}

/* ----------------------------- Electron 实现 ----------------------------- */

function entryFromScan(f: ScannedFile): ImageEntry {
  const url = `twinview://local/${encodeURIComponent(f.path)}`
  return {
    id: f.path,
    name: f.name,
    path: f.path,
    size: f.size,
    lastModified: f.lastModified,
    getUrl: () => Promise.resolve(url),
    revoke() {
      /* 自定义协议无需释放 */
    },
  }
}

class ElectronFSProvider implements FSProvider {
  kind = 'electron' as const

  private bridge(): TwinviewBridge {
    if (!window.twinview) throw new Error('Electron bridge 不可用')
    return window.twinview
  }

  async pickDirectory(): Promise<DirectorySource | null> {
    const r = await this.bridge().selectDirectory()
    if (!r) return null
    // 选中文件 → 打开所在文件夹并定位选中该文件（focusFile 由 store 处理）
    if (r.isFile) {
      const norm = r.path.replace(/\\/g, '/')
      const i = norm.lastIndexOf('/')
      return { name: norm.slice(0, i), dirPath: norm.slice(0, i), focusFile: r.path }
    }
    return { name: r.path, dirPath: r.path }
  }

  onCliOpen(cb: (payload: CliOpenPayload) => void): () => void {
    return this.bridge().onCliOpen(cb)
  }

  async listImages(dir: DirectorySource, recursive: boolean): Promise<ImageEntry[]> {
    if (!dir.dirPath) return []
    const files = await this.bridge().scanDirectory(dir.dirPath, recursive)
    return files.map(entryFromScan)
  }

  async scanPath(dirPath: string, recursive: boolean) {
    const files = await this.bridge().scanDirectory(dirPath, recursive)
    return {
      dir: { name: dirPath, dirPath } as DirectorySource,
      images: files.map(entryFromScan),
    }
  }

  async listDirs(absPath: string): Promise<DirInfo[]> {
    return this.bridge().listDirs(absPath)
  }

  async listAncestors(absPath: string): Promise<DirInfo[]> {
    return this.bridge().getAncestors(absPath)
  }

  async readFileBuffer(absPath: string): Promise<Uint8Array | null> {
    return this.bridge().readFileBuffer(absPath)
  }

  async copyFiles(sources: string[], targetDir: string): Promise<FileOpResult> {
    return this.bridge().copyFiles(sources, targetDir)
  }

  async makeDir(parent: string, name: string): Promise<{ ok: boolean; error?: string }> {
    return this.bridge().makeDir(parent, name)
  }

  async trashItems(paths: string[]): Promise<FileOpResult> {
    return this.bridge().trashItems(paths)
  }

  async specialDirs() {
    return this.bridge().specialDirs()
  }

  async browseDir(dir: string | null) {
    return this.bridge().browseDir(dir)
  }

  async dirImagePreview(dir: string, limit: number, shallow?: boolean) {
    return this.bridge().dirImagePreview(dir, limit, shallow)
  }

  getPathForFile(file: File): string {
    return this.bridge().getPathForFile(file)
  }

  async copyInto(sources: string[], targetDir: string): Promise<FileOpResult> {
    return this.bridge().copyInto(sources, targetDir)
  }
}

/* ----------------------------- 运行时探测 ----------------------------- */

let cached: FSProvider | null = null

export function getFSProvider(): FSProvider {
  if (!cached) {
    cached = isElectron() ? new ElectronFSProvider() : new BrowserFSProvider()
  }
  return cached
}
