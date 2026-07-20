/**
 * TwinView Electron 主进程
 * - dev：加载 http://localhost:7100（Vite dev server）
 * - prod：加载 dist/index.html
 * - IPC：select-directory（系统对话框）、scan-directory（递归扫描图片）
 * - 自定义协议 twinview://local/<encodeURIComponent(绝对路径)> 提供本地文件（免拷贝）
 */
const { app, BrowserWindow, dialog, ipcMain, protocol, net, Menu, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const { pathToFileURL } = require('node:url')

const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.svg', '.ico', '.tif', '.tiff',
])

const DEV_URL = process.env.TWINVIEW_DEV_URL || 'http://localhost:7100'

// 冒烟测试模式：TWINVIEW_SMOKE=1 时自动验证扫描 / 截图 / 渲染进程后退出
const SMOKE = process.env.TWINVIEW_SMOKE === '1'
// 生产加载分支：打包后或显式 NODE_ENV=production 时加载 dist/index.html
const LOAD_DIST = app.isPackaged || process.env.NODE_ENV === 'production'
const SMOKE_TEST_DIR = path.resolve(__dirname, '..', '..', 'test-photos')
const SMOKE_SHOT = path.resolve(__dirname, '..', 'smoke-home.png')

// 必须在 app ready 之前注册为特权 scheme，renderer 才能 fetch/img 加载
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'twinview',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

/** 递归收集目录下所有图片文件 */
async function pathExists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** 重名副本命名：n=0 → "base - 副本.ext"，n≥1 → "base - 副本 (n+1).ext" */
function copyNameOf(name, n) {
  const i = name.lastIndexOf('.')
  const base = i > 0 ? name.slice(0, i) : name
  const ext = i > 0 ? name.slice(i) : ''
  return n === 0 ? `${base} - 副本${ext}` : `${base} - 副本 (${n + 1})${ext}`
}

async function scanDirectory(dir, recursive, out = []) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    try {
      if (ent.isDirectory()) {
        if (recursive) await scanDirectory(full, true, out)
      } else if (ent.isFile() && IMAGE_EXTS.has(path.extname(ent.name).toLowerCase())) {
        const stat = await fs.stat(full)
        out.push({
          path: full,
          name: ent.name,
          size: stat.size,
          lastModified: Math.round(stat.mtimeMs),
        })
      }
    } catch {
      // 跳过无权限/损坏项
    }
  }
  return out
}

/** 列出一层子目录：含各子目录本层图片数与是否有下级目录（文件夹树懒加载） */
async function listDirsLayer(dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const full = path.join(dir, ent.name)
    let imageCount = 0
    let hasSubdirs = false
    try {
      const sub = await fs.readdir(full, { withFileTypes: true })
      for (const s of sub) {
        if (s.isDirectory()) hasSubdirs = true
        else if (s.isFile() && IMAGE_EXTS.has(path.extname(s.name).toLowerCase())) imageCount += 1
      }
    } catch {
      // 无权限目录：保留节点但计数为 0
    }
    out.push({ name: ent.name, path: full, imageCount, hasSubdirs })
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
  return out
}

/** 祖先目录链：从 dir 逐级向上到盘符/根（不含自身，root-first），每层统计本层直接图片数 */
async function ancestorChain(dir) {
  const chain = []
  let cur = path.resolve(dir)
  for (let guard = 0; guard < 64; guard++) {
    const parent = path.dirname(cur)
    if (parent === cur) break
    chain.unshift(parent)
    cur = parent
  }
  const out = []
  for (const p of chain) {
    let imageCount = 0
    try {
      const entries = await fs.readdir(p, { withFileTypes: true })
      for (const ent of entries) {
        if (ent.isFile() && IMAGE_EXTS.has(path.extname(ent.name).toLowerCase())) imageCount += 1
      }
    } catch {
      // 无权限目录：计数为 0
    }
    out.push({ name: path.basename(p) || p, path: p, imageCount, hasSubdirs: true })
  }
  return out
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#1e1e1e',
    title: 'TwinView 图片对比浏览器',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // 精简菜单：仅保留视图操作，便于开发调试
  const menu = Menu.buildFromTemplate([
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ])
  Menu.setApplicationMenu(menu)

  // 外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (LOAD_DIST) {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  } else {
    void win.loadURL(DEV_URL)
  }

  if (SMOKE) void runSmokeTest(win)
}

/** 冒烟测试：扫描校验 → 截图 → 渲染进程校验 → 退出 */
async function runSmokeTest(win) {
  const fail = (msg) => {
    console.error(`[SMOKE-FAIL] ${msg}`)
    app.exit(1)
  }
  // 硬超时保护
  const killer = setTimeout(() => fail('冒烟测试超时（60s）'), 60000)

  win.webContents.once('did-finish-load', async () => {
    try {
      // a) 主进程直接复用 scan-directory 逻辑扫描测试目录（递归）
      const files = await scanDirectory(SMOKE_TEST_DIR, true)
      const byExt = {}
      for (const f of files) {
        const ext = path.extname(f.name).toLowerCase()
        byExt[ext] = (byExt[ext] || 0) + 1
      }
      const hasSub = files.some((f) => f.path.includes(`${path.sep}sub${path.sep}`))
      console.log(`[SMOKE] 扫描目录: ${SMOKE_TEST_DIR}`)
      console.log(`[SMOKE] 图片总数: ${files.length}（期望 10）`)
      console.log(`[SMOKE] 格式分布: ${JSON.stringify(byExt)}`)
      console.log(`[SMOKE] 包含 sub 子目录文件: ${hasSub}`)
      if (files.length !== 10 || !hasSub) {
        clearTimeout(killer)
        return fail(`扫描结果不符预期: total=${files.length}, hasSub=${hasSub}`)
      }

      // a.2) 验证 list-dirs（文件夹树 IPC 逻辑）：根下应有 sub/（本层 2 张图）
      const dirs = await listDirsLayer(SMOKE_TEST_DIR)
      const subNode = dirs.find((d) => d.name === 'sub')
      console.log(`[SMOKE] list-dirs 根层: ${JSON.stringify(dirs.map((d) => ({ name: d.name, imageCount: d.imageCount, hasSubdirs: d.hasSubdirs })))}`)
      if (!subNode || subNode.imageCount !== 2) {
        clearTimeout(killer)
        return fail(`list-dirs 结果不符预期: ${JSON.stringify(dirs)}`)
      }

      // a.3) 验证 path-ancestors（祖先链 IPC）：最后一级应为测试目录的父目录
      const anc = await ancestorChain(SMOKE_TEST_DIR)
      const lastAnc = anc[anc.length - 1]
      console.log(`[SMOKE] path-ancestors: ${anc.length} 级，最近祖先: ${lastAnc ? lastAnc.path : '(无)'}`)
      if (anc.length < 1 || !lastAnc || lastAnc.path !== path.dirname(SMOKE_TEST_DIR)) {
        clearTimeout(killer)
        return fail(`path-ancestors 结果不符预期: ${JSON.stringify(anc.map((a) => a.path))}`)
      }

      // a.4) read-file-buffer + 渲染端 blob 解码链路（直方图/EXIF 的数据来源；canvas 不被污染）
      const chain = await win.webContents.executeJavaScript(`(async () => {
        try {
          const buf = await window.twinview.readFileBuffer(${JSON.stringify(files[0].path)})
          if (!buf || buf.byteLength === 0) return { ok: false, step: 'readFileBuffer 返回空' }
          const blob = new Blob([buf])
          const bmp = await createImageBitmap(blob)
          const c = document.createElement('canvas')
          c.width = 8; c.height = 8
          const ctx = c.getContext('2d')
          ctx.drawImage(bmp, 0, 0, 8, 8)
          const d = ctx.getImageData(0, 0, 8, 8).data
          let sum = 0
          for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2]
          return { ok: sum > 0, bytes: buf.byteLength, pixelSum: sum }
        } catch (e) { return { ok: false, error: String(e) } }
      })()`)
      console.log(`[SMOKE] read-file-buffer/blob 解码链路: ${JSON.stringify(chain)}`)
      if (!chain.ok) {
        clearTimeout(killer)
        return fail(`read-file-buffer 链路不符预期: ${JSON.stringify(chain)}`)
      }

      // a.5) 文件操作 IPC：make-dir → copy-files（含重名副本）→ trash-items → 清理
      const osTmp = require('node:os').tmpdir()
      const opsDirName = `twinview-smoke-ops-${Date.now()}`
      const opsDir = path.join(osTmp, opsDirName)
      const ops = await win.webContents.executeJavaScript(`(async () => {
        const out = {}
        out.mkdir = await window.twinview.makeDir(${JSON.stringify(osTmp)}, ${JSON.stringify(opsDirName)})
        out.copy1 = await window.twinview.copyFiles([${JSON.stringify(files[0].path)}], ${JSON.stringify(opsDir)})
        out.copy2 = await window.twinview.copyFiles([${JSON.stringify(files[0].path)}], ${JSON.stringify(opsDir)})
        out.trash = await window.twinview.trashItems([${JSON.stringify(path.join(opsDir, path.basename(files[0].path)))}])
        return out
      })()`)
      console.log(`[SMOKE] 文件操作 IPC: ${JSON.stringify(ops)}`)
      await fs.rm(opsDir, { recursive: true, force: true })
      const opsOk =
        ops.mkdir && ops.mkdir.ok === true &&
        Array.isArray(ops.copy1 && ops.copy1.ok) && ops.copy1.ok.length === 1 &&
        Array.isArray(ops.copy2 && ops.copy2.ok) && ops.copy2.ok.length === 1 && ops.copy2.ok[0].includes('副本') &&
        Array.isArray(ops.trash && ops.trash.ok) && ops.trash.ok.length === 1
      if (!opsOk) {
        clearTimeout(killer)
        return fail(`文件操作 IPC 不符预期: ${JSON.stringify(ops)}`)
      }

      // b) 等 3 秒让渲染进程 UI 稳定后截图（capturePage 偶发 UnknownVizError，重试 3 次）
      await new Promise((r) => setTimeout(r, 3000))
      let image = null
      let lastCapErr = null
      for (let attempt = 0; attempt < 3 && !image; attempt++) {
        try {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 1000))
          image = await win.webContents.capturePage()
        } catch (e) {
          lastCapErr = e
          console.log(`[SMOKE] 截图第 ${attempt + 1} 次失败，重试…（${String(e)}）`)
        }
      }
      if (!image) throw lastCapErr || new Error('capturePage 失败')
      await fs.writeFile(SMOKE_SHOT, image.toPNG())
      console.log(`[SMOKE] 截图已保存: ${SMOKE_SHOT}`)

      // c) 渲染进程环境检查
      const info = await win.webContents.executeJavaScript(`({
        title: document.title,
        hasBridge: typeof window.twinview === 'object' && window.twinview !== null,
        platform: window.twinview ? window.twinview.platform : null,
        bodyTextLen: document.body ? document.body.innerText.length : 0,
        buttonCount: document.querySelectorAll('button').length,
        rootChildren: document.getElementById('root') ? document.getElementById('root').childElementCount : 0,
      })`)
      console.log(`[SMOKE] 渲染进程: ${JSON.stringify(info)}`)
      if (!info.hasBridge || info.bodyTextLen < 20 || info.buttonCount < 3 || info.rootChildren < 1) {
        clearTimeout(killer)
        return fail(`渲染进程检查不符预期: ${JSON.stringify(info)}`)
      }

      // d) 渲染进程内经 twinview:// 协议加载真实文件，验证自定义协议链路
      // 应用实际通过 <img> 加载图片，故同时探测 fetch 与 <img> 两种方式
      const sample = files[0].path
      const probe = await win.webContents.executeJavaScript(
        `(async () => {
          const url = 'twinview://local/' + encodeURIComponent(${JSON.stringify(sample)})
          const imgProbe = await new Promise((resolve) => {
            const img = new Image()
            img.onload = () => resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight })
            img.onerror = () => resolve({ ok: false, error: 'img onerror' })
            img.src = url
          })
          let fetchProbe
          try {
            const res = await fetch(url)
            const buf = await res.arrayBuffer()
            fetchProbe = { ok: res.ok, status: res.status, bytes: buf.byteLength }
          } catch (e) {
            fetchProbe = { ok: false, status: -1, bytes: 0, error: String(e) }
          }
          return { imgProbe, fetchProbe }
        })()`,
      )
      console.log(`[SMOKE] twinview:// 协议探测: ${JSON.stringify(probe)}（文件: ${sample}）`)
      if (!probe.imgProbe.ok || probe.imgProbe.w <= 0) {
        clearTimeout(killer)
        return fail(`twinview:// <img> 加载失败: ${JSON.stringify(probe.imgProbe)}`)
      }

      console.log('[SMOKE] 全部通过')
      clearTimeout(killer)
      app.exit(0)
    } catch (err) {
      clearTimeout(killer)
      fail(err && err.stack ? err.stack : String(err))
    }
  })
}

app.whenReady().then(() => {
  // twinview://local/<encodeURIComponent(绝对路径)> → 本地文件
  // 附加 CORS 头：file:// 页面（生产模式）里 fetch 该协议时跨源校验需要
  protocol.handle('twinview', async (request) => {
    if (SMOKE) console.log(`[SMOKE] 协议请求: ${request.url}`)
    try {
      const url = new URL(request.url)
      const filePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const res = await net.fetch(pathToFileURL(filePath).toString())
      const headers = new Headers(res.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    } catch (err) {
      return new Response(`Not found: ${String(err)}`, { status: 404 })
    }
  })

  ipcMain.handle('select-directory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win, {
      title: '选择图片文件夹',
      properties: ['openDirectory'],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle('scan-directory', async (_event, dir, recursive) => {
    if (typeof dir !== 'string' || dir.length === 0) return []
    return scanDirectory(dir, !!recursive)
  })

  // 列出一层子目录（文件夹树懒加载）
  ipcMain.handle('list-dirs', async (_event, dir) => {
    if (typeof dir !== 'string' || dir.length === 0) return []
    return listDirsLayer(dir)
  })

  // 祖先目录链（文件夹树顶部，root-first 不含自身）
  ipcMain.handle('path-ancestors', async (_event, dir) => {
    if (typeof dir !== 'string' || dir.length === 0) return []
    return ancestorChain(dir)
  })

  // 读取文件字节（渲染进程据此创建 blob: URL，用于直方图抽样与 EXIF 解析，避免 twinview:// 污染 canvas）
  ipcMain.handle('read-file-buffer', async (_event, filePath) => {
    if (typeof filePath !== 'string' || filePath.length === 0) return null
    const stat = await fs.stat(filePath)
    if (stat.size > 512 * 1024 * 1024) throw new Error('文件过大（>512MB）')
    return fs.readFile(filePath)
  })

  // 复制文件到目标目录（重名自动加 " - 副本"/" - 副本 (n)" 后缀），返回 {ok, failed}
  ipcMain.handle('copy-files', async (_event, sources, targetDir) => {
    const ok = []
    const failed = []
    if (!Array.isArray(sources) || typeof targetDir !== 'string' || !targetDir) return { ok, failed }
    for (const src of sources) {
      if (typeof src !== 'string' || !src) continue
      const name = path.basename(src)
      try {
        let dest = path.join(targetDir, name)
        let n = 0
        while (await pathExists(dest)) {
          dest = path.join(targetDir, copyNameOf(name, n))
          n += 1
        }
        await fs.copyFile(src, dest)
        ok.push(path.basename(dest))
      } catch (err) {
        failed.push({ name, error: String((err && err.message) || err) })
      }
    }
    return { ok, failed }
  })

  // 新建文件夹，返回 {ok, error?}
  ipcMain.handle('make-dir', async (_event, parent, name) => {
    try {
      if (typeof parent !== 'string' || !parent) return { ok: false, error: '目标目录无效' }
      if (typeof name !== 'string' || !name.trim() || /[\\/:*?"<>|]/.test(name)) {
        return { ok: false, error: '名称无效（不能包含 \\ / : * ? " < > |）' }
      }
      const target = path.join(parent, name.trim())
      if (await pathExists(target)) return { ok: false, error: '已存在同名文件或文件夹' }
      await fs.mkdir(target)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
  })

  // 移入回收站（shell.trashItem），返回 {ok, failed}
  ipcMain.handle('trash-items', async (_event, paths) => {
    const ok = []
    const failed = []
    if (!Array.isArray(paths)) return { ok, failed }
    for (const p of paths) {
      if (typeof p !== 'string' || !p) continue
      try {
        await shell.trashItem(p)
        ok.push(path.basename(p))
      } catch (err) {
        failed.push({ name: path.basename(p), error: String((err && err.message) || err) })
      }
    }
    return { ok, failed }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
