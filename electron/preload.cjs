/**
 * TwinView preload：以 contextBridge 暴露最小 IPC 接口为 window.twinview
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('twinview', {
  /** 弹出系统选择框（win32 文件/文件夹均可选），返回 {path, isFile} 或 null */
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  /** 订阅主进程 CLI 下发（单实例转发同源），返回取消订阅函数 */
  onCliOpen: (cb) => {
    const listener = (_event, payload) => cb(payload)
    ipcRenderer.on('cli-open', listener)
    return () => ipcRenderer.removeListener('cli-open', listener)
  },
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
  /** 主题窗口背景同步（#rrggbb） */
  setWindowBackground: (color) => ipcRenderer.invoke('set-window-background', color),
  /** 打开文件夹对话框：常用位置快捷入口，返回 {name,path}[] */
  specialDirs: () => ipcRenderer.invoke('special-dirs'),
  /** 打开文件夹对话框：列一层子目录（null = 顶层盘符/根），返回 {path,parent,dirs} */
  browseDir: (dir) => ipcRenderer.invoke('browse-dir', dir),
  /** 目录图片预览：默认递归计数 + 前 limit 张；shallow=true 只列本层（附 dirs 子文件夹条目），返回 {count,capped,images:[{path,name}],dirs?} */
  dirImagePreview: (dir, limit, shallow) => ipcRenderer.invoke('dir-image-preview', dir, limit, shallow),
  /** 拖放：File 对象 → 绝对路径（webUtils） */
  getPathForFile: (file) => webUtils.getPathForFile(file),
  /** 拖放粘贴：递归复制文件/目录到目标目录（重名自动副本），返回 {ok, failed} */
  copyInto: (sources, targetDir) => ipcRenderer.invoke('copy-into', sources, targetDir),
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
})
