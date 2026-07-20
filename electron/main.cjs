/**
 * TwinView Electron 主进程
 * - dev：加载 http://localhost:7100（Vite dev server）
 * - prod：加载 dist/index.html
 * - CLI：TwinView.exe <路径>（文件夹直接打开；文件打开所在文件夹并选中）、
 *   --compare <A> <B>（A/B 对比）、--recursive / --theme / --layout / --help；
 *   单实例（second-instance 转发参数到现有窗口），解析后经 cli-open IPC 下发渲染进程
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

/* ------------------------- CLI 参数解析与单实例 ------------------------- */

const CLI_HELP = `TwinView 图片对比浏览器
用法:
  TwinView.exe <文件夹>                    打开文件夹
  TwinView.exe <图片文件>                  打开所在文件夹并选中该图片
  TwinView.exe --compare <图片A> <图片B>   打开共同所在文件夹并进入 A/B 对比
可选参数:
  --recursive                      本次会话开启「含子文件夹」
  --theme dark|light|system        指定主题
  --layout wipe|side|overlay|grid  对比显示模式（配合 --compare）
  --help                           打印本说明
未识别的参数会被忽略并警告到 stdout。`

/** 解析 CLI 参数（argv 已切掉 electron/应用路径；容忍前导 --） */
function parseCliArgs(argv) {
  const out = { kind: null, paths: [], flags: {}, warnings: [], help: false }
  const args = [...argv]
  if (args[0] === '--') args.shift()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--help' || a === '-h') {
      out.help = true
      continue
    }
    if (a === '--compare') {
      const x = args[i + 1]
      const y = args[i + 2]
      if (x && y && !x.startsWith('--') && !y.startsWith('--')) {
        out.kind = 'compare'
        out.paths = [x, y]
        i += 2
      } else {
        out.warnings.push('--compare 需要两个图片路径参数')
      }
      continue
    }
    if (a === '--recursive') {
      out.flags.recursive = true
      continue
    }
    if (a === '--theme') {
      const v = args[i + 1]
      if (v === 'dark' || v === 'light' || v === 'system') {
        out.flags.theme = v
        i += 1
      } else {
        out.warnings.push(`--theme 无效值: ${v ?? '(缺失)'}（可选 dark|light|system）`)
      }
      continue
    }
    if (a === '--layout') {
      const v = args[i + 1]
      if (v === 'wipe' || v === 'side' || v === 'overlay' || v === 'grid') {
        out.flags.layout = v
        i += 1
      } else {
        out.warnings.push(`--layout 无效值: ${v ?? '(缺失)'}（可选 wipe|side|overlay|grid）`)
      }
      continue
    }
    if (a.startsWith('--')) {
      out.warnings.push(`未识别参数: ${a}`)
      continue
    }
    if (out.kind === null) {
      out.kind = 'folder'
      out.paths = [a]
    } else {
      out.warnings.push(`多余的路径参数: ${a}`)
    }
  }
  return out
}

/** 解析 → stat 判型 → 经 cli-open IPC 下发渲染进程（窗口未加载完则等加载后下发） */
async function dispatchCli(argv, win) {
  if (!win || win.isDestroyed()) return
  const cli = parseCliArgs(argv)
  for (const w of cli.warnings) console.log(`[CLI] 警告: ${w}`)
  if (cli.help) console.log(CLI_HELP)
  if (!cli.kind) return
  const payload = { kind: cli.kind, paths: cli.paths, flags: cli.flags, isFile: false }
  try {
    const st = await fs.stat(cli.paths[0])
    if (cli.kind === 'folder') payload.isFile = st.isFile()
    if (cli.kind === 'compare' && !st.isFile()) {
      console.log(`[CLI] 警告: 不是图片文件 ${cli.paths[0]}`)
      return
    }
    if (cli.kind === 'compare') {
      const stB = await fs.stat(cli.paths[1])
      if (!stB.isFile()) {
        console.log(`[CLI] 警告: 不是图片文件 ${cli.paths[1]}`)
        return
      }
    }
  } catch {
    console.log(`[CLI] 警告: 路径不存在或不可读 ${cli.paths[0]}`)
    return
  }
  const send = () => {
    if (!win.isDestroyed()) win.webContents.send('cli-open', payload)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
}

/** 当前进程自己的 CLI argv（打包后 slice(1)，dev electron . 下 slice(2)） */
function selfCliArgv() {
  return process.argv.slice(app.isPackaged ? 1 : 2)
}

// 单实例：已运行时再次调用 → second-instance 把新参数转发给现有窗口（焦点前置），不新开窗口。
// 冒烟模式跳过锁（允许与常驻实例并行自检）。
const gotSingleInstanceLock = SMOKE ? true : app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
    void dispatchCli(argv.slice(app.isPackaged ? 1 : 2), win)
  })
}

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

      // a.5b) 「打开文件夹」对话框 IPC：special-dirs / browse-dir / dir-image-preview
      const dlg = await win.webContents.executeJavaScript(`(async () => {
        const out = {}
        out.specials = (await window.twinview.specialDirs()).map((s) => s.name)
        const top = await window.twinview.browseDir(null)
        out.topDirs = top.dirs.length
        const layer = await window.twinview.browseDir(${JSON.stringify(SMOKE_TEST_DIR)})
        out.testSubdirs = layer.dirs.map((d) => d.name)
        const prev = await window.twinview.dirImagePreview(${JSON.stringify(SMOKE_TEST_DIR)}, 4)
        out.previewCount = prev.count
        out.previewImages = prev.images.length
        return out
      })()`)
      console.log(`[SMOKE] 打开对话框 IPC: ${JSON.stringify(dlg)}`)
      const dlgOk =
        Array.isArray(dlg.specials) && dlg.specials.length >= 3 &&
        dlg.topDirs >= 1 &&
        Array.isArray(dlg.testSubdirs) && dlg.testSubdirs.includes('sub') &&
        dlg.previewCount === 10 && dlg.previewImages === 4
      if (!dlgOk) {
        clearTimeout(killer)
        return fail(`打开对话框 IPC 不符预期: ${JSON.stringify(dlg)}`)
      }

      // a.6) UI 验证：自动打开测试目录 → 子文件夹卡片 / 面包屑 / 列表模式 / Backspace 返回
      const ui = await win.webContents.executeJavaScript(`(async () => {
        const store = window.__twinviewStore
        if (!store) return { ok: false, step: 'no __twinviewStore（需 dev 构建）' }
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        await store.getState().openPath(${JSON.stringify(SMOKE_TEST_DIR)})
        for (let i = 0; i < 50; i++) {
          const s = store.getState()
          if (!s.loading && s.images.length > 0 && s.treeChildren['']) break
          await wait(100)
        }
        const s = store.getState()
        const out = { images: s.images.length }
        // 递归视野：先显式关闭验证根层 8 张，再开启验证全量 10 张（与历史持久化状态无关，确定性断言）
        s.setRecursive(false)
        await wait(300)
        out.defaultVisible = document.querySelectorAll('[data-thumb]').length
        s.setRecursive(true)
        await wait(300)
        out.hasSubdirNode = (s.treeChildren[''] || []).some((n) => n.name === 'sub')
        out.breadcrumb = document.querySelector('nav') !== null
        await wait(400)
        out.folderCards = document.querySelectorAll('[data-folder]').length
        // 切列表模式：图片行 + 文件夹行
        s.setBrowseMode('list')
        await wait(300)
        out.listRows = document.querySelectorAll('[data-thumb]').length
        out.listFolderRows = document.querySelectorAll('[data-folder]').length
        // 进入 sub 子目录：面包屑应出现第二段
        s.setCurrentPath('sub')
        await wait(200)
        out.crumbsAfterEnter = document.querySelectorAll('nav button').length
        // Backspace 等价操作：返回根
        s.navigateUp()
        out.backToRoot = store.getState().currentPath === ''
        s.setBrowseMode('medium')
        // 主题三档：亮 → html 无 dark class；暗 → 恢复 dark
        s.setTheme('light')
        await wait(150)
        out.lightOk = !document.documentElement.classList.contains('dark')
        s.setTheme('dark')
        await wait(150)
        out.darkOk = document.documentElement.classList.contains('dark')
        // 「打开文件夹」对话框：渲染快捷入口 + 子目录 + 预览计数后关闭
        s.setOpenFolderDialog(true)
        await wait(1200)
        const dlgEl = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('打开此文件夹'))
        out.dialogOpen = !!dlgEl
        out.dialogHasSub = [...document.querySelectorAll('button')].some((b) => b.textContent.trim().startsWith('sub'))
        s.setOpenFolderDialog(false)
        await wait(200)
        out.ok = out.images === 10 && out.defaultVisible === 8 && out.hasSubdirNode && out.breadcrumb &&
          out.folderCards >= 1 && out.listRows === 10 && out.listFolderRows >= 1 &&
          out.crumbsAfterEnter >= 2 && out.backToRoot && out.lightOk && out.darkOk &&
          out.dialogOpen && out.dialogHasSub
        return out
      })()`)
      console.log(`[SMOKE] UI 验证: ${JSON.stringify(ui)}`)
      if (!ui.ok) {
        clearTimeout(killer)
        return fail(`UI 验证不符预期: ${JSON.stringify(ui)}`)
      }

      // a.7) CLI cli-open 注入：folder+file 定位选中 → --compare 两图槽位/布局/主题 flag
      const cliA = path.join(SMOKE_TEST_DIR, 'A1_red_800x600.jpg')
      const cliB = path.join(SMOKE_TEST_DIR, 'sub', 'S1_sub_700x500.jpg')
      win.webContents.send('cli-open', { kind: 'folder', paths: [cliB], flags: {}, isFile: true })
      const cliFolder = await win.webContents.executeJavaScript(`(async () => {
        const store = window.__twinviewStore
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        for (let i = 0; i < 50; i++) {
          const s = store.getState()
          if (!s.loading && s.currentId && s.currentId.endsWith('S1_sub_700x500.jpg')) break
          await wait(100)
        }
        const s = store.getState()
        return { currentId: s.currentId, viewMode: s.viewMode, images: s.images.length }
      })()`)
      console.log(`[SMOKE] CLI folder+file: ${JSON.stringify(cliFolder)}`)
      if (!cliFolder.currentId || !cliFolder.currentId.endsWith('S1_sub_700x500.jpg') || cliFolder.images !== 2) {
        clearTimeout(killer)
        return fail(`CLI folder+file 定位不符预期（应打开 sub 文件夹=2 张并选中文件）: ${JSON.stringify(cliFolder)}`)
      }
      win.webContents.send('cli-open', { kind: 'compare', paths: [cliA, cliB], flags: { layout: 'side', theme: 'dark', recursive: true } })
      const cliCompare = await win.webContents.executeJavaScript(`(async () => {
        const store = window.__twinviewStore
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        for (let i = 0; i < 50; i++) {
          const s = store.getState()
          if (!s.loading && s.viewMode === 'compare' && s.slotB) break
          await wait(100)
        }
        const s = store.getState()
        const out = {
          viewMode: s.viewMode, slotA: s.slotA, slotB: s.slotB,
          layout: s.compareLayout, theme: s.theme, recursive: s.recursive,
        }
        // 复位浏览视图（不干扰后续截图）
        s.setViewMode('browse')
        await wait(200)
        return out
      })()`)
      console.log(`[SMOKE] CLI compare: ${JSON.stringify(cliCompare)}`)
      const cliCmpOk =
        cliCompare.viewMode === 'compare' &&
        typeof cliCompare.slotA === 'string' && cliCompare.slotA.endsWith('A1_red_800x600.jpg') &&
        typeof cliCompare.slotB === 'string' && cliCompare.slotB.endsWith('S1_sub_700x500.jpg') &&
        cliCompare.layout === 'side' && cliCompare.theme === 'dark' && cliCompare.recursive === true
      if (!cliCmpOk) {
        clearTimeout(killer)
        return fail(`CLI compare 注入不符预期: ${JSON.stringify(cliCompare)}`)
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

// 主初始化仅在持有单实例锁时执行（未持锁进程已 app.quit，避免仍建窗）
if (gotSingleInstanceLock) app.whenReady().then(() => {
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

  // 主题窗口背景同步（渲染进程主题切换时调用，避免切换瞬间闪白/闪黑）
  ipcMain.handle('set-window-background', async (event, color) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) win.setBackgroundColor(color)
  })

  // 「打开文件夹」对话框：常用位置快捷入口（桌面/图片/文档/下载/主目录 + 盘符）
  ipcMain.handle('special-dirs', async () => {
    const out = []
    const push = async (name, p) => {
      try {
        if (p && (await pathExists(p))) out.push({ name, path: p })
      } catch {
        /* 单个位置不可用时跳过 */
      }
    }
    await push('桌面', app.getPath('desktop'))
    await push('图片', app.getPath('pictures'))
    await push('文档', app.getPath('documents'))
    await push('下载', app.getPath('downloads'))
    await push('主目录', app.getPath('home'))
    if (process.platform === 'win32') {
      for (let c = 67; c <= 90; c += 1) {
        const letter = String.fromCharCode(c)
        const drive = `${letter}:\\`
        if (await pathExists(drive)) out.push({ name: `本地磁盘 (${letter}:)`, path: drive })
      }
    } else {
      out.push({ name: '根目录', path: '/' })
    }
    return out
  })

  // 「打开文件夹」对话框：列出一层子目录（dir 为 null 时返回顶层盘符/根）
  ipcMain.handle('browse-dir', async (_event, dir) => {
    if (typeof dir !== 'string' || !dir) {
      if (process.platform === 'win32') {
        const drives = []
        for (let c = 67; c <= 90; c += 1) {
          const letter = String.fromCharCode(c)
          const drive = `${letter}:\\`
          if (await pathExists(drive)) {
            drives.push({ name: `${letter}:`, path: drive, imageCount: 0, hasSubdirs: true })
          }
        }
        return { path: null, parent: null, dirs: drives }
      }
      return { path: '/', parent: null, dirs: await listDirsLayer('/') }
    }
    const parent = path.dirname(dir)
    return { path: dir, parent: parent === dir ? null : parent, dirs: await listDirsLayer(dir) }
  })

  // 目录图片预览：递归扫描（20000 项防爆上限），返回总数与前 limit 张
  const PREVIEW_SCAN_CAP = 20000
  ipcMain.handle('dir-image-preview', async (_event, dir, limit) => {
    const images = []
    let count = 0
    let capped = false
    const cap = typeof limit === 'number' && limit > 0 ? Math.min(limit, 64) : 12
    async function walk(d) {
      if (capped) return
      let entries
      try {
        entries = await fs.readdir(d, { withFileTypes: true })
      } catch {
        return
      }
      // 文件优先（预览更早出现），子目录排后
      entries.sort(
        (a, b) =>
          (a.isDirectory() ? 1 : 0) - (b.isDirectory() ? 1 : 0) ||
          a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }),
      )
      for (const ent of entries) {
        if (capped) return
        const full = path.join(d, ent.name)
        try {
          if (ent.isDirectory()) {
            await walk(full)
          } else if (ent.isFile() && IMAGE_EXTS.has(path.extname(ent.name).toLowerCase())) {
            count += 1
            if (images.length < cap) images.push({ path: full, name: ent.name })
            if (count >= PREVIEW_SCAN_CAP) {
              capped = true
              return
            }
          }
        } catch {
          // 跳过无权限/损坏项
        }
      }
    }
    if (typeof dir === 'string' && dir) await walk(dir)
    return { count, capped, images }
  })

  // 拖放粘贴：递归复制文件/目录到目标目录（重名自动加副本后缀，目录整体复制）
  ipcMain.handle('copy-into', async (_event, sources, targetDir) => {
    const ok = []
    const failed = []
    if (!Array.isArray(sources) || typeof targetDir !== 'string' || !targetDir) return { ok, failed }
    async function copyOne(src, destDir) {
      const name = path.basename(src)
      try {
        const stat = await fs.stat(src)
        let destName = name
        let n = 0
        while (await pathExists(path.join(destDir, destName))) {
          destName = copyNameOf(name, n)
          n += 1
        }
        const dest = path.join(destDir, destName)
        if (stat.isDirectory()) {
          await fs.mkdir(dest)
          const children = await fs.readdir(src)
          for (const child of children) await copyOne(path.join(src, child), dest)
          ok.push(`${destName}/`)
        } else {
          await fs.copyFile(src, dest)
          ok.push(destName)
        }
      } catch (err) {
        failed.push({ name, error: String((err && err.message) || err) })
      }
    }
    for (const src of sources) {
      if (typeof src !== 'string' || !src) continue
      await copyOne(src, targetDir)
    }
    return { ok, failed }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 仅在拿到单实例锁时启动主窗口；拿不到锁的进程已在上方 app.quit()
if (gotSingleInstanceLock) {
  void app.whenReady().then(() => {
    const win = BrowserWindow.getAllWindows()[0]
    // 首次启动携带的 CLI 参数（冒烟模式跳过，由冒烟自行注入 cli-open）
    if (!SMOKE && win) void dispatchCli(selfCliArgv(), win)
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
