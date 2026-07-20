/**
 * 文件操作：粘贴（复制到当前目录）/ 新建文件夹 / 删除
 * - Electron：走 IPC（copy-files / make-dir / trash-items，删除进回收站）
 * - 浏览器 FS Access：目录句柄 API（需 readwrite 权限；删除为 handle.remove()，不进回收站、不可恢复）
 * - webkitdirectory 回退：不支持写操作（菜单项禁用并注明）
 */
import type { DirectorySource, FileOpResult, ImageEntry } from './fs-provider'
import { getFSProvider } from './fs-provider'
import { isAbsPath, normalizeSlashes } from './dir-tree'

/** 当前目录是否支持写操作 */
export function writeSupported(dir: DirectorySource | null): boolean {
  if (!dir) return false
  if (getFSProvider().kind === 'electron') return !!dir.dirPath
  return !!dir.handle
}

export function writeUnsupportedReason(dir: DirectorySource | null): string | null {
  if (writeSupported(dir)) return null
  if (dir?.files) return '浏览器回退模式（webkitdirectory）不支持写操作'
  return '当前环境不支持写操作'
}

/** 重名副本命名：n=0 → "base - 副本.ext"，n≥1 → "base - 副本 (n+1).ext"（与主进程一致） */
export function copyNameOf(name: string, n: number): string {
  const i = name.lastIndexOf('.')
  const base = i > 0 ? name.slice(0, i) : name
  const ext = i > 0 ? name.slice(i) : ''
  return n === 0 ? `${base} - 副本${ext}` : `${base} - 副本 (${n + 1})${ext}`
}

/* ------------------------- FS Access 句柄辅助 ------------------------- */

interface PermissionHandle {
  queryPermission(desc: { mode: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>
  requestPermission(desc: { mode: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>
}

interface WDirHandle {
  kind: 'directory'
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<WDirHandle>
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<WFileHandle>
}

interface WFileHandle {
  kind: 'file'
  getFile(): Promise<File>
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>
  remove(): Promise<void>
}

async function resolveDirHandle(root: FileSystemDirectoryHandle, relPath: string): Promise<WDirHandle> {
  let h = root as unknown as WDirHandle
  if (relPath && !isAbsPath(relPath)) {
    for (const seg of relPath.split('/')) {
      h = await h.getDirectoryHandle(seg)
    }
  }
  return h
}

async function ensureReadWrite(root: FileSystemDirectoryHandle): Promise<boolean> {
  const h = root as unknown as PermissionHandle
  if (typeof h.queryPermission !== 'function' || typeof h.requestPermission !== 'function') return true
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true
  return (await h.requestPermission({ mode: 'readwrite' })) === 'granted'
}

/** Electron 目标目录解析：currentPath 可能是根内相对路径或祖先链绝对路径 */
export function electronTargetDir(dir: DirectorySource, targetRelPath: string): string {
  if (isAbsPath(targetRelPath)) return normalizeSlashes(targetRelPath)
  return targetRelPath ? `${dir.dirPath!}/${targetRelPath}` : dir.dirPath!
}

/* ------------------------- 粘贴（复制到当前目录） ------------------------- */

export async function pasteFiles(
  entries: ImageEntry[],
  targetRelPath: string,
  dir: DirectorySource,
): Promise<FileOpResult> {
  const provider = getFSProvider()
  const result: FileOpResult = { ok: [], failed: [] }

  if (provider.kind === 'electron') {
    if (!provider.copyFiles || !dir.dirPath) {
      return { ok: [], failed: entries.map((e) => ({ name: e.name, error: '当前环境不支持写操作' })) }
    }
    return provider.copyFiles(
      entries.map((e) => e.path),
      electronTargetDir(dir, targetRelPath),
    )
  }

  // 浏览器 FS Access
  if (!dir.handle) {
    return { ok: [], failed: entries.map((e) => ({ name: e.name, error: '浏览器回退模式不支持写操作' })) }
  }
  if (!(await ensureReadWrite(dir.handle))) {
    return { ok: [], failed: entries.map((e) => ({ name: e.name, error: '未授予写入权限' })) }
  }
  let target: WDirHandle
  try {
    target = await resolveDirHandle(dir.handle, targetRelPath)
  } catch {
    return { ok: [], failed: entries.map((e) => ({ name: e.name, error: '目标目录不可达' })) }
  }
  for (const e of entries) {
    try {
      if (!e.handle) throw new Error('无文件句柄')
      const handle = e.handle as unknown as WFileHandle
      // 重名检测：原名 → " - 副本" → " - 副本 (2)" …
      let name = e.name
      for (let n = -1; ; n += 1) {
        name = n < 0 ? e.name : copyNameOf(e.name, n)
        let exists = true
        try {
          await target.getFileHandle(name)
        } catch {
          exists = false
        }
        if (!exists) break
      }
      const out = await target.getFileHandle(name, { create: true })
      const w = await out.createWritable()
      await w.write(await handle.getFile())
      await w.close()
      result.ok.push(name)
    } catch (err) {
      result.failed.push({ name: e.name, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return result
}

/* ------------------------- 拖放（复制到当前目录） ------------------------- */

/** 拖放项：file 为文件；children 为目录（递归） */
export interface DropItem {
  name: string
  file?: File
  children?: DropItem[]
}

/** 浏览器 FS Access：把拖放项树写入目标目录（重名自动副本，目录递归创建） */
export async function dropToDirectory(
  items: DropItem[],
  targetRelPath: string,
  dir: DirectorySource,
  onProgress?: (done: number, total: number) => void,
): Promise<FileOpResult> {
  const countFiles = (list: DropItem[]): number =>
    list.reduce((n, it) => n + (it.file ? 1 : it.children ? countFiles(it.children) : 0), 0)
  const total = countFiles(items)
  const failAll = (error: string): FileOpResult => ({
    ok: [],
    failed: items.map((i) => ({ name: i.name, error })),
  })
  if (!dir.handle) return failAll('浏览器回退模式（webkitdirectory）不支持拖放写入')
  if (!(await ensureReadWrite(dir.handle))) return failAll('未授予写入权限')
  let target: WDirHandle
  try {
    target = await resolveDirHandle(dir.handle, targetRelPath)
  } catch {
    return failAll('目标目录不可达')
  }

  const result: FileOpResult = { ok: [], failed: [] }
  let done = 0
  const uniqueName = async (parent: WDirHandle, name: string, isDir: boolean): Promise<string> => {
    for (let n = -1; ; n += 1) {
      const candidate = n < 0 ? name : copyNameOf(name, n)
      let exists = true
      try {
        if (isDir) await parent.getDirectoryHandle(candidate)
        else await parent.getFileHandle(candidate)
      } catch {
        exists = false
      }
      if (!exists) return candidate
    }
  }
  const writeItem = async (it: DropItem, parent: WDirHandle): Promise<void> => {
    if (it.file) {
      try {
        const name = await uniqueName(parent, it.name, false)
        const out = await parent.getFileHandle(name, { create: true })
        const w = await out.createWritable()
        await w.write(it.file)
        await w.close()
        result.ok.push(name)
      } catch (err) {
        result.failed.push({ name: it.name, error: err instanceof Error ? err.message : String(err) })
      }
      done += 1
      onProgress?.(done, total)
      return
    }
    if (it.children) {
      try {
        const name = await uniqueName(parent, it.name, true)
        const sub = await parent.getDirectoryHandle(name, { create: true })
        result.ok.push(`${name}/`)
        for (const c of it.children) await writeItem(c, sub)
      } catch (err) {
        result.failed.push({ name: `${it.name}/`, error: err instanceof Error ? err.message : String(err) })
        // 目录失败时其内文件也算完成遍历（避免进度卡死）
        const skip = countFiles([it])
        done += skip
        onProgress?.(done, total)
      }
    }
  }
  for (const it of items) await writeItem(it, target)
  return result
}

/** DataTransferItemList → DropItem 树（webkitGetAsEntry 递归遍历目录） */
export async function dropItemsFromDataTransfer(dt: DataTransfer): Promise<DropItem[]> {
  interface WEntry {
    isFile: boolean
    isDirectory: boolean
    name: string
    file?: (cb: (f: File) => void, eb?: (e: unknown) => void) => void
    createReader?: () => { readEntries: (cb: (es: WEntry[]) => void, eb?: (e: unknown) => void) => void }
  }
  const readEntry = async (entry: WEntry): Promise<DropItem | null> => {
    if (entry.isFile && entry.file) {
      const file = await new Promise<File | null>((resolve) => {
        entry.file!((f) => resolve(f), () => resolve(null))
      })
      return file ? { name: entry.name, file } : null
    }
    if (entry.isDirectory && entry.createReader) {
      const reader = entry.createReader()
      const entries: WEntry[] = []
      // readEntries 每次最多返回 100 项，需循环读到空批
      for (;;) {
        const batch = await new Promise<WEntry[]>((resolve) => {
          reader.readEntries((es) => resolve(es), () => resolve([]))
        })
        if (batch.length === 0) break
        entries.push(...batch)
      }
      const children: DropItem[] = []
      for (const e of entries) {
        const child = await readEntry(e)
        if (child) children.push(child)
      }
      return { name: entry.name, children }
    }
    return null
  }

  const items: DropItem[] = []
  const entryItems: WEntry[] = []
  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file') continue
    const getEntry = (item as DataTransferItem & { webkitGetAsEntry?: () => WEntry | null }).webkitGetAsEntry
    const entry = getEntry?.call(item)
    if (entry) entryItems.push(entry)
  }
  if (entryItems.length > 0) {
    for (const e of entryItems) {
      const it = await readEntry(e)
      if (it) items.push(it)
    }
    return items
  }
  // 回退：无 entry API（少见），按扁平文件处理
  for (const f of Array.from(dt.files)) items.push({ name: f.name, file: f })
  return items
}

/* ------------------------- 新建文件夹 ------------------------- */

export async function makeDirectory(
  name: string,
  targetRelPath: string,
  dir: DirectorySource,
): Promise<{ ok: boolean; error?: string }> {
  const provider = getFSProvider()
  const trimmed = name.trim()
  if (!trimmed || /[\\/:*?"<>|]/.test(trimmed)) {
    return { ok: false, error: '名称无效（不能包含 \\ / : * ? " < > |）' }
  }
  if (provider.kind === 'electron') {
    if (!provider.makeDir || !dir.dirPath) return { ok: false, error: '当前环境不支持写操作' }
    return provider.makeDir(electronTargetDir(dir, targetRelPath), trimmed)
  }
  if (!dir.handle) return { ok: false, error: '浏览器回退模式不支持写操作' }
  if (!(await ensureReadWrite(dir.handle))) return { ok: false, error: '未授予写入权限' }
  try {
    const target = await resolveDirHandle(dir.handle, targetRelPath)
    let exists = true
    try {
      await target.getDirectoryHandle(trimmed)
    } catch {
      exists = false
    }
    if (exists) return { ok: false, error: '已存在同名文件夹' }
    await target.getDirectoryHandle(trimmed, { create: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/* ------------------------- 删除 ------------------------- */

export async function trashEntries(
  entries: ImageEntry[],
  dir: DirectorySource,
): Promise<FileOpResult> {
  const provider = getFSProvider()
  if (provider.kind === 'electron') {
    if (!provider.trashItems) {
      return { ok: [], failed: entries.map((e) => ({ name: e.name, error: '当前环境不支持删除' })) }
    }
    return provider.trashItems(entries.map((e) => e.path))
  }
  // FS Access：handle.remove() 直删（不进回收站，不可恢复）
  const result: FileOpResult = { ok: [], failed: [] }
  if (!dir.handle) {
    return { ok: [], failed: entries.map((e) => ({ name: e.name, error: '浏览器回退模式不支持写操作' })) }
  }
  if (!(await ensureReadWrite(dir.handle))) {
    return { ok: [], failed: entries.map((e) => ({ name: e.name, error: '未授予写入权限' })) }
  }
  for (const e of entries) {
    try {
      const h = e.handle as unknown as WFileHandle | undefined
      if (!h || typeof h.remove !== 'function') {
        throw new Error('浏览器不支持删除（需要 Chrome 110+）')
      }
      await h.remove()
      result.ok.push(e.name)
    } catch (err) {
      result.failed.push({ name: e.name, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return result
}
