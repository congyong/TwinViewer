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
function electronTargetDir(dir: DirectorySource, targetRelPath: string): string {
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
