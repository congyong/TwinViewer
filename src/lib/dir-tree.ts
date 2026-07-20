/**
 * 文件夹树工具：三种数据源统一产出 DirNode
 * - Electron：IPC 按层返回（store 中调用 provider.listDirs）
 * - 浏览器 File System Access API：用目录 handle 按层枚举
 * - 浏览器 webkitdirectory 回退：从已扫描图片的相对路径反推
 */
import type { DirectorySource, ImageEntry } from '@/lib/fs-provider'
import { isImageFile } from '@/lib/fs-provider'

export interface DirNode {
  name: string
  /** 相对根目录的路径（'' = 根） */
  relPath: string
  /** 图片数：Electron / FS Access 为本层直接图片数；webkitdirectory 回退为含子树的递归数 */
  imageCount: number
  hasChildren: boolean
}

/** 计算图片所在目录相对根的路径（'' = 根目录本层） */
export function relDirOf(entry: ImageEntry, dir: DirectorySource | null): string {
  if (!dir) return ''
  let p = entry.path
  if (dir.dirPath) {
    // Electron：绝对路径 → 去掉根前缀
    if (p.startsWith(dir.dirPath)) p = p.slice(dir.dirPath.length)
    p = p.replace(/^[\\/]+/, '')
  } else if (dir.files) {
    // webkitdirectory 回退：相对路径首段是根文件夹名，去掉
    const idx = p.indexOf('/')
    p = idx >= 0 ? p.slice(idx + 1) : ''
  }
  // FS Access：扫描时已是相对根的路径
  p = p.replace(/\\/g, '/')
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

/** 判断 relDir 是否在当前目录视野内（recursive=含子树） */
export function inScope(relDir: string, currentPath: string, recursive: boolean): boolean {
  if (currentPath === '') return recursive ? true : relDir === ''
  if (recursive) return relDir === currentPath || relDir.startsWith(`${currentPath}/`)
  return relDir === currentPath
}

/** 是否为文件系统绝对路径（Windows 盘符 / UNC / POSIX 根） */
export function isAbsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
}

/** 规范化为正斜杠路径 */
export function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 取绝对路径的所在目录（正斜杠形式） */
export function absDirOf(absPath: string): string {
  const p = normalizeSlashes(absPath)
  const i = p.lastIndexOf('/')
  if (i < 0) return p
  if (i === 0) return '/'
  return p.slice(0, i)
}

/** 视野判断（支持根内相对路径与祖先链绝对路径两种 currentPath） */
export function scopeOk(
  entry: ImageEntry,
  dir: DirectorySource | null,
  currentPath: string,
  recursive: boolean,
): boolean {
  if (isAbsPath(currentPath)) {
    const absDir = absDirOf(entry.path)
    const cur = normalizeSlashes(currentPath)
    if (recursive) return absDir === cur || absDir.startsWith(`${cur}/`)
    return absDir === cur
  }
  return inScope(relDirOf(entry, dir), currentPath, recursive)
}

function sortNodes(nodes: DirNode[]): DirNode[] {
  return nodes.sort((a, b) =>
    a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }),
  )
}

interface HandleLike {
  kind: string
  name: string
  values(): AsyncIterable<HandleLike>
  getDirectoryHandle(name: string): Promise<HandleLike>
}

/** FS Access 模式：枚举 relPath 一层的子目录（同时统计各子目录本层图片数与是否有下级目录） */
export async function fsAccessChildren(
  rootHandle: FileSystemDirectoryHandle,
  relPath: string,
): Promise<DirNode[]> {
  let h = rootHandle as unknown as HandleLike
  if (relPath) {
    for (const seg of relPath.split('/')) {
      h = await h.getDirectoryHandle(seg)
    }
  }
  const nodes: DirNode[] = []
  for await (const child of h.values()) {
    if (child.kind !== 'directory') continue
    let imageCount = 0
    let hasChildren = false
    for await (const s of child.values()) {
      if (s.kind === 'directory') hasChildren = true
      else if (isImageFile(s.name)) imageCount += 1
    }
    nodes.push({
      name: child.name,
      relPath: relPath ? `${relPath}/${child.name}` : child.name,
      imageCount,
      hasChildren,
    })
  }
  return sortNodes(nodes)
}

/** webkitdirectory 回退：从图片相对路径反推 relPath 一层的子目录（计数为递归数） */
export function fallbackChildren(
  images: ImageEntry[],
  dir: DirectorySource,
  relPath: string,
): DirNode[] {
  const map = new Map<string, { imageCount: number; hasChildren: boolean }>()
  const prefix = relPath === '' ? '' : `${relPath}/`
  for (const e of images) {
    const rd = relDirOf(e, dir)
    if (relPath !== '' && rd !== relPath && !rd.startsWith(prefix)) continue
    if (rd === relPath) continue // 本层文件，不属于任何子目录
    const rest = relPath === '' ? rd : rd.slice(prefix.length)
    const first = rest.split('/')[0]
    if (!first) continue
    const rec = map.get(first) ?? { imageCount: 0, hasChildren: false }
    rec.imageCount += 1
    if (rest.includes('/')) rec.hasChildren = true
    map.set(first, rec)
  }
  return sortNodes(
    [...map.entries()].map(([name, rec]) => ({
      name,
      relPath: relPath ? `${relPath}/${name}` : name,
      imageCount: rec.imageCount,
      hasChildren: rec.hasChildren,
    })),
  )
}
