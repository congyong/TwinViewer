/**
 * TwinView preload：以 contextBridge 暴露最小 IPC 接口为 window.twinview
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('twinview', {
  /** 弹出系统目录选择框，返回绝对路径或 null */
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  /** 递归/非递归扫描目录，返回 {path,name,size,lastModified}[] */
  scanDirectory: (dir, recursive) => ipcRenderer.invoke('scan-directory', dir, recursive),
  /** 列出一层子目录，返回 {name,path,imageCount,hasSubdirs}[] */
  listDirs: (dir) => ipcRenderer.invoke('list-dirs', dir),
  /** 祖先目录链（root-first，不含自身），返回 {name,path,imageCount,hasSubdirs}[] */
  getAncestors: (dir) => ipcRenderer.invoke('path-ancestors', dir),
  /** 读取文件字节（返回 Uint8Array），用于 blob 解码/分析 */
  readFileBuffer: (path) => ipcRenderer.invoke('read-file-buffer', path),
  /** 复制文件到目标目录（重名自动加副本后缀），返回 {ok, failed} */
  copyFiles: (sources, targetDir) => ipcRenderer.invoke('copy-files', sources, targetDir),
  /** 新建文件夹，返回 {ok, error?} */
  makeDir: (parent, name) => ipcRenderer.invoke('make-dir', parent, name),
  /** 移入回收站，返回 {ok, failed} */
  trashItems: (paths) => ipcRenderer.invoke('trash-items', paths),
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
})
