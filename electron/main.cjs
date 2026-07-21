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
const { app, BrowserWindow, dialog, ipcMain, protocol, net, Menu, shell, desktopCapturer } = require('electron')
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
  --layout wipe|side|overlay|diff|grid  对比显示模式（配合 --compare）
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
      if (v === 'wipe' || v === 'side' || v === 'overlay' || v === 'diff' || v === 'grid') {
        out.flags.layout = v
        i += 1
      } else {
        out.warnings.push(`--layout 无效值: ${v ?? '(缺失)'}（可选 wipe|side|overlay|diff|grid）`)
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
        // shallow=true：只列本层（8 张），附本层子文件夹条目，缩略图不含子目录
        const shallow = await window.twinview.dirImagePreview(${JSON.stringify(SMOKE_TEST_DIR)}, 12, true)
        out.shallowCount = shallow.count
        out.shallowDirs = (shallow.dirs || []).map((d) => d.name)
        out.shallowHasSubImage = shallow.images.some((im) => im.path.includes('sub'))
        return out
      })()`)
      console.log(`[SMOKE] 打开对话框 IPC: ${JSON.stringify(dlg)}`)
      const dlgOk =
        Array.isArray(dlg.specials) && dlg.specials.length >= 3 &&
        dlg.topDirs >= 1 &&
        Array.isArray(dlg.testSubdirs) && dlg.testSubdirs.includes('sub') &&
        dlg.previewCount === 10 && dlg.previewImages === 4 &&
        dlg.shallowCount === 8 && Array.isArray(dlg.shallowDirs) && dlg.shallowDirs.includes('sub') &&
        dlg.shallowHasSubImage === false
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

      // a.8) 真全屏布局 + 对比/网格槽位导航（状态级模拟；不依赖 headless Fullscreen API）
      const navAssert = await win.webContents.executeJavaScript(`(async () => {
        const store = window.__twinviewStore
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const out = {}
        const S = () => store.getState()
        // --- 真全屏：physicalFullscreen=true → chrome 卸载；false → 恢复 ---
        S().setViewMode('browse')
        await wait(200)
        out.chromeBefore = {
          toolbar: !!document.querySelector('[data-chrome="toolbar"]'),
          aside: !!document.querySelector('aside'),
        }
        store.setState({ physicalFullscreen: true })
        await wait(250)
        out.fsHidden =
          !document.querySelector('[data-chrome="toolbar"]') &&
          !document.querySelector('aside') &&
          !document.querySelector('[data-chrome="filmstrip"]')
        store.setState({ physicalFullscreen: false })
        await wait(250)
        out.fsRestored = !!document.querySelector('[data-chrome="toolbar"]') && !!document.querySelector('aside')
        // --- 对比槽位导航：仅勾选 2 张占满 A/B → 回退不跳过（A/B 同图）+ 无 notice；切「全部」→ 步进且跳过另一槽 ---
        const ids = S().images.map((e) => e.id) // 10 张，按名称序 A1..B4, sub 两张在最后（按排序）
        const [idA, idB] = ids
        store.setState({ checked: [idA, idB], navScope: 'checked' })
        S().startCompareFromChecked()
        await wait(250)
        out.cmpSetup = S().viewMode === 'compare' && S().slotA === idA && S().slotB === idB
        S().navigate(1)
        await wait(100)
        // 仅勾选 2 张占满 A/B：跳过后无目标 → 回退为不跳过，A 步进到与 B 同图（允许重复），无 notice
        out.checkedDupStep = S().slotA === idB && S().slotB === idB
        out.noNotice = S().notice === null && !document.querySelector('[data-notice]')
        store.setState({ navScope: 'all', slotA: idA, notice: null })
        await wait(100)
        const third = ids[2]
        S().navigate(1)
        await wait(100)
        out.allStep = S().slotA === third // A1 → 跳过 A2（B 槽）→ 第三张
        S().navigate(1)
        await wait(100)
        out.allStep2 = S().slotA === ids[3]
        // 激活侧切到 B：Tab 等价（此时 A=ids[3]，B=ids[1]；B 步进 → ids[2] 未被占据）
        S().toggleActiveSlot()
        S().navigate(1)
        await wait(100)
        out.activeBStep = S().slotB === ids[2] && S().slotA === ids[3]
        // X 交换不回归
        S().swapSlots()
        out.swapOk = S().slotA === ids[2] && S().slotB === ids[3]
        // --- 网格：激活格步进跳过其他格占据项 ---
        const g = [ids[0], ids[1], ids[2]]
        store.setState({ viewMode: 'grid', gridIds: g, gridActiveIdx: 0, checked: [], navScope: 'all', notice: null })
        await wait(150)
        S().navigate(1)
        await wait(100)
        out.gridSkip = S().gridIds[0] === ids[3] // 格0: A1 → 跳过 A2/A3（格1/格2）→ ids[3]
        // 网格回退：仅勾选 2 张占满 2 格 → 激活格步进到与其他格同图（允许重复），无 notice
        store.setState({ gridIds: [ids[0], ids[1]], gridActiveIdx: 0, checked: [ids[0], ids[1]], navScope: 'checked', notice: null })
        await wait(100)
        S().navigate(1)
        await wait(100)
        out.gridDupStep = S().gridIds[0] === ids[1] && S().gridIds[1] === ids[1] && S().notice === null
        // 复位（不干扰截图）
        store.setState({ viewMode: 'browse', gridIds: [], checked: [], notice: null })
        S().setViewMode('browse')
        await wait(200)
        out.ok = out.chromeBefore.toolbar && out.chromeBefore.aside && out.fsHidden && out.fsRestored &&
          out.cmpSetup && out.checkedDupStep && out.noNotice && out.allStep && out.allStep2 &&
          out.activeBStep && out.swapOk && out.gridSkip && out.gridDupStep
        return out
      })()`)
      console.log(`[SMOKE] 真全屏布局+槽位导航: ${JSON.stringify(navAssert)}`)
      if (!navAssert.ok) {
        clearTimeout(killer)
        return fail(`真全屏/槽位导航不符预期: ${JSON.stringify(navAssert)}`)
      }

      // a.9) 视图级物理全屏（Shift+F 直进，无 fullscreenCell）：视图普通分支渲染悬浮迷你条，pane 布局不变，chrome 全卸载
      const fsAssert = await win.webContents.executeJavaScript(`(async () => {
        const store = window.__twinviewStore
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const out = {}
        const S = () => store.getState()
        const panes = () => document.querySelectorAll('[data-view-pane]').length
        const chromeGone = () =>
          !document.querySelector('[data-chrome="toolbar"]') &&
          !document.querySelector('aside') &&
          !document.querySelector('[data-chrome="filmstrip"]')
        const ids = S().images.map((e) => e.id)
        // 对比（并排 2 图）→ 物理全屏（无单格）：2 pane 均在 + 迷你条出现 + chrome 全隐
        store.setState({ viewMode: 'compare', slotA: ids[0], slotB: ids[1], compareLayout: 'side', fullscreenCell: null, checked: [], navScope: 'all' })
        await wait(300)
        out.before = { panes: panes(), minibar: !!document.querySelector('[data-minibar]') }
        store.setState({ physicalFullscreen: true })
        await wait(300)
        out.cmpPanes = panes()
        out.cmpMinibar = !!document.querySelector('[data-minibar]')
        out.cmpChromeGone = chromeGone()
        store.setState({ physicalFullscreen: false })
        await wait(300)
        out.cmpRestored = !!document.querySelector('[data-chrome="toolbar"]') && !!document.querySelector('aside') && panes() === 2
        // 网格 4 图 → 物理全屏：4 个 pane 均在 + 迷你条
        store.setState({ viewMode: 'grid', gridIds: [ids[0], ids[1], ids[2], ids[3]], gridActiveIdx: 0, fullscreenCell: null })
        await wait(250)
        store.setState({ physicalFullscreen: true })
        await wait(300)
        out.gridPanes = panes()
        out.gridMinibar = !!document.querySelector('[data-minibar]')
        out.gridChromeGone = chromeGone()
        store.setState({ physicalFullscreen: false })
        store.setState({ viewMode: 'browse', gridIds: [] })
        S().setViewMode('browse')
        await wait(200)
        out.ok = out.before.panes === 2 && !out.before.minibar &&
          out.cmpPanes === 2 && out.cmpMinibar && out.cmpChromeGone && out.cmpRestored &&
          out.gridPanes === 4 && out.gridMinibar && out.gridChromeGone
        return out
      })()`)
      console.log(`[SMOKE] 视图级物理全屏: ${JSON.stringify(fsAssert)}`)
      if (!fsAssert.ok) {
        clearTimeout(killer)
        return fail(`视图级物理全屏不符预期: ${JSON.stringify(fsAssert)}`)
      }

      // a.10) 双击三层交互链：L0 双击格→L1 控件全屏（事件级）；L1 双击→L2 物理全屏（action 触发请求 + 状态级模拟）；
      //       L2 双击→L3 循环切显示源（对比 A↔B 槽位内容不变；网格下一格格组不变）；退出后 chrome 恢复
      const chainAssert = await win.webContents.executeJavaScript(`(async () => {
        const store = window.__twinviewStore
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const out = {}
        const S = () => store.getState()
        const panes = () => document.querySelectorAll('[data-view-pane]').length
        const ids = S().images.map((e) => e.id)
        // --- 对比 side：真实 dblclick 事件进 L1 ---
        store.setState({ viewMode: 'compare', slotA: ids[0], slotB: ids[1], compareLayout: 'side', activeSlot: 'A', fullscreenCell: null, physicalFullscreen: false, checked: [], navScope: 'all' })
        await wait(300)
        const paneA = document.querySelector('[data-view-pane]')
        paneA.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        await wait(300)
        out.dblL1 = S().fullscreenCell === 'A' && panes() === 1
        // --- L1→L2：action 触发物理全屏请求（headless 下只报告结果，不断言）---
        S().fullscreenDblClick('A')
        await wait(300)
        out.physicalRequested = S().physicalFullscreen // 报告值；headless 可能被拒
        store.setState({ physicalFullscreen: true }) // 状态级模拟 L2
        await wait(300)
        // --- L2→L3：双击 = 切显示源 A→B→A，槽位内容不变，迷你条在 ---
        const slotABefore = [S().slotA, S().slotB]
        S().fullscreenDblClick('A')
        await wait(250)
        out.l3toB = S().fullscreenCell === 'B'
        S().fullscreenDblClick('B')
        await wait(250)
        out.l3toA = S().fullscreenCell === 'A'
        out.slotsKept = S().slotA === slotABefore[0] && S().slotB === slotABefore[1]
        out.l3Minibar = !!document.querySelector('[data-minibar]') && panes() === 1
        // --- 退出：physical false + fullscreenCell null → chrome 恢复、2 pane ---
        store.setState({ physicalFullscreen: false })
        S().setFullscreenCell(null)
        await wait(300)
        out.exited = S().fullscreenCell === null && panes() === 2 && !!document.querySelector('aside')
        // --- L1 控件全屏下 X 切显示源（槽位互换+激活侧翻转）后 ←/→ 仍对**显示槽**生效 ---
        store.setState({ viewMode: 'compare', slotA: ids[0], slotB: ids[1], compareLayout: 'side', activeSlot: 'A', fullscreenCell: 'A', physicalFullscreen: false })
        await wait(250)
        S().swapSlots() // X：显示格 'A' 现显示原 B 图；activeSlot 翻转为 'B'
        await wait(100)
        out.xSwapKept = S().slotA === ids[1] && S().slotB === ids[0] && S().activeSlot === 'B' && S().fullscreenCell === 'A'
        S().navigate(1) // 应作用于显示槽 A（ids[1]）→ 跳过 slotB=ids[0] → ids[2]
        await wait(100)
        out.navAfterX = S().slotA === ids[2] && S().slotB === ids[0]
        S().navigate(-1) // 回退到 ids[1]
        await wait(100)
        out.navBackAfterX = S().slotA === ids[1] && S().slotB === ids[0]
        store.setState({ fullscreenCell: null })
        await wait(150)
        // --- 网格 3 格：action 进 L1=格'0'；L2 中双击 → '1'→'2'，gridIds 内容不变 ---
        const g = [ids[0], ids[1], ids[2]]
        store.setState({ viewMode: 'grid', gridIds: g.slice(), gridActiveIdx: 0, fullscreenCell: null, physicalFullscreen: false })
        await wait(250)
        S().fullscreenDblClick('0')
        await wait(250)
        out.gridL1 = S().fullscreenCell === '0' && panes() === 1
        store.setState({ physicalFullscreen: true })
        await wait(250)
        S().fullscreenDblClick('0')
        await wait(200)
        out.gridL3a = S().fullscreenCell === '1'
        S().fullscreenDblClick('1')
        await wait(200)
        out.gridL3b = S().fullscreenCell === '2'
        out.gridIdsKept = S().gridIds.length === 3 && S().gridIds.every((id, i) => id === g[i])
        // --- 网格 L1 显示格='2'（gridActiveIdx 仍为 0）时 ←/→ 作用于显示格 ---
        S().navigate(1) // 显示格 ids[2] → 跳过格0/格1 → ids[3]
        await wait(100)
        out.gridNavAfterL3 = S().gridIds[2] === ids[3] && S().gridIds[0] === ids[0] && S().gridIds[1] === ids[1]
        // 复位
        store.setState({ physicalFullscreen: false, fullscreenCell: null, viewMode: 'browse', gridIds: [] })
        S().setViewMode('browse')
        await wait(200)
        out.ok = out.dblL1 && out.l3toB && out.l3toA && out.slotsKept && out.l3Minibar &&
          out.exited && out.xSwapKept && out.navAfterX && out.navBackAfterX &&
          out.gridL1 && out.gridL3a && out.gridL3b && out.gridIdsKept && out.gridNavAfterL3
        return out
      })()`)
      console.log(`[SMOKE] 双击三层链: ${JSON.stringify(chainAssert)}`)
      if (!chainAssert.ok) {
        clearTimeout(killer)
        return fail(`双击三层链不符预期: ${JSON.stringify(chainAssert)}`)
      }

      // a.11) 对比视图点击文件夹树节点 → 切回浏览模式且 currentPath 正确；浏览中点击行为不变；Esc 不回归
      const treeAssert = await win.webContents.executeJavaScript(`(async () => {
        const store = window.__twinviewStore
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const out = {}
        const S = () => store.getState()
        const ids = S().images.map((e) => e.id)
        // 对比模式（并排，根目录视野）下点击树中 sub 节点行（行 title = relPath）
        store.setState({ viewMode: 'compare', slotA: ids[0], slotB: ids[1], compareLayout: 'side', currentPath: '', fullscreenCell: null, physicalFullscreen: false, checked: [], navScope: 'all' })
        await wait(300)
        out.inCompare = S().viewMode === 'compare' && !!document.querySelector('aside')
        const subRow = document.querySelector('aside div[title="sub"]')
        out.nodeFound = !!subRow
        if (subRow) {
          subRow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          await wait(300)
        }
        out.toBrowse = S().viewMode === 'browse'
        out.pathOk = S().currentPath === 'sub'
        // 浏览模式中点树根节点：仍在浏览、path 回根（既有行为不变）
        const rootRow = document.querySelector('aside div[title="根目录"]')
        out.rootFound = !!rootRow
        if (rootRow) {
          rootRow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          await wait(300)
        }
        out.browseStays = S().viewMode === 'browse' && S().currentPath === ''
        // Esc 不回归：再进对比 → Esc → 回浏览
        store.setState({ viewMode: 'compare', slotA: ids[0], slotB: ids[1], compareLayout: 'side' })
        await wait(250)
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await wait(250)
        out.escBack = S().viewMode === 'browse'
        // 复位
        store.setState({ viewMode: 'browse', currentPath: '', fullscreenCell: null, checked: [] })
        await wait(200)
        out.ok = out.inCompare && out.nodeFound && out.toBrowse && out.pathOk &&
          out.rootFound && out.browseStays && out.escBack
        return out
      })()`)
      console.log(`[SMOKE] 树点击回浏览: ${JSON.stringify(treeAssert)}`)
      if (!treeAssert.ok) {
        clearTimeout(killer)
        return fail(`树点击回浏览不符预期: ${JSON.stringify(treeAssert)}`)
      }

      // a.12) 差值热图：UI 挂载（配置面板+滑块+diff canvas）+ 同图全黑 + 异图非黑 + 滑块联动 store +
      //       面板仅 diff 可见 + 单元级（合成位图）：容差单调抑制与置黑阈值、四种必需 colormap
      //       （inferno/gray/viridis/coolwarm）齐全有序且可切换、coolwarm 中点近白/两端蓝红、gray 消色差
      const diffAssert = await win.webContents.executeJavaScript(`(async () => {
        const store = window.__twinviewStore
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const out = {}
        const S = () => store.getState()
        const ids = S().images.map((e) => e.id)
        store.setState({ viewMode: 'compare', slotA: ids[0], slotB: ids[1], compareLayout: 'diff', diffTolerance: 16, diffColormap: 'inferno', fullscreenCell: null, physicalFullscreen: false })
        await wait(900)
        out.panelShown = !!document.querySelector('[data-diff-panel]')
        const c0 = document.querySelector('[data-diff-canvas]')
        out.canvasShown = !!c0 && c0.width > 0
        const center = () => {
          const c = document.querySelector('[data-diff-canvas]')
          const x = c.getContext('2d')
          const d = x.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data
          return [d[0], d[1], d[2]]
        }
        out.diffNonBlack = center().some((v) => v > 0)
        // 同图（A1 vs A1）→ 全黑
        store.setState({ slotA: ids[0], slotB: ids[0] })
        await wait(800)
        out.sameBlack = center().every((v) => v === 0)
        // 容差滑块：面板内含 range 滑块 + 数值输入，且拖动滑块联动 store
        const slider = document.querySelector('[data-diff-tolerance]')
        out.sliderShown = !!slider && slider.type === 'range' && !!document.querySelector('[data-diff-tolerance-num]')
        if (slider) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          setter.call(slider, '80')
          slider.dispatchEvent(new Event('input', { bubbles: true }))
          await wait(200)
          out.sliderWired = S().diffTolerance === 80
          store.setState({ diffTolerance: 16 })
          await wait(300)
        } else {
          out.sliderWired = false
        }
        // 面板仅 diff 布局可见：切到并排即隐藏，切回 diff 即显示
        store.setState({ compareLayout: 'side' })
        await wait(300)
        out.panelHiddenOutsideDiff = !document.querySelector('[data-diff-panel]')
        store.setState({ compareLayout: 'diff' })
        await wait(500)
        out.panelBackInDiff = !!document.querySelector('[data-diff-panel]')
        // 单元级：合成位图精确验证（d=100 恒定）
        const { computeDiffBitmap, getDiffLut } = await import('/src/lib/diffmap.ts')
        const { DIFF_COLORMAP_VALUES } = await import('/src/lib/settings.ts')
        const mk = async (rgb) => {
          const c = document.createElement('canvas'); c.width = 4; c.height = 4
          const x = c.getContext('2d'); x.fillStyle = rgb; x.fillRect(0, 0, 4, 4)
          return createImageBitmap(c)
        }
        const read = async (bmp) => {
          const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height
          const x = c.getContext('2d'); x.drawImage(bmp, 0, 0)
          return Array.from(x.getImageData(1, 1, 1, 1).data.slice(0, 3))
        }
        const bmpA = await mk('rgb(200,100,50)')
        const bmpB = await mk('rgb(100,100,50)')
        const g16 = await read(await computeDiffBitmap(bmpA, bmpB, 16, 'gray'))
        const g64 = await read(await computeDiffBitmap(bmpA, bmpB, 64, 'gray'))
        const g100 = await read(await computeDiffBitmap(bmpA, bmpB, 100, 'gray'))
        out.tolEffect = g16[0] > g64[0] && g64[0] > 0 && g100.every((v) => v === 0)
        // gray 消色差：计算输出与 LUT 抽查均 R=G=B
        const gl = getDiffLut('gray')
        out.grayAchromatic = g16[0] === g16[1] && g16[1] === g16[2] &&
          [0, 64, 128, 192, 255].every((i) => gl[i * 3] === gl[i * 3 + 1] && gl[i * 3 + 1] === gl[i * 3 + 2])
        // coolwarm 发散：中点近白；左端偏蓝、右端偏红
        const cl = getDiffLut('coolwarm')
        const mid = [cl[128 * 3], cl[128 * 3 + 1], cl[128 * 3 + 2]]
        out.coolwarmMidWhite = mid.every((v) => v >= 200)
        out.coolwarmEnds = cl[2] > cl[0] && cl[255 * 3] > cl[255 * 3 + 2]
        // 四种必需 colormap：单一来源列表齐全且顺序在前（inferno/gray/viridis/coolwarm），且均可切换生效
        out.cmapsListed = JSON.stringify(DIFF_COLORMAP_VALUES.slice(0, 4)) === JSON.stringify(['inferno', 'gray', 'viridis', 'coolwarm'])
        out.cmapsSwitchable = true
        for (const cm of DIFF_COLORMAP_VALUES) {
          S().setDiffColormap(cm)
          const lut = getDiffLut(cm)
          if (S().diffColormap !== cm || !lut || lut.length !== 768) out.cmapsSwitchable = false
        }
        S().setDiffColormap('inferno')
        const ci = await read(await computeDiffBitmap(bmpA, bmpB, 16, 'inferno'))
        const cv = await read(await computeDiffBitmap(bmpA, bmpB, 16, 'viridis'))
        out.cmapDiffers = ci.some((v, i) => v !== cv[i])
        bmpA.close(); bmpB.close()
        // 复位
        store.setState({ viewMode: 'browse', compareLayout: 'side', slotA: null, slotB: null, diffTolerance: 16, diffColormap: 'inferno' })
        S().setViewMode('browse')
        await wait(200)
        out.ok = out.panelShown && out.canvasShown && out.diffNonBlack && out.sameBlack &&
          out.sliderShown && out.sliderWired && out.panelHiddenOutsideDiff && out.panelBackInDiff &&
          out.tolEffect && out.grayAchromatic && out.coolwarmMidWhite && out.coolwarmEnds &&
          out.cmapsListed && out.cmapsSwitchable && out.cmapDiffers
        return out
      })()`)
      console.log(`[SMOKE] 差值热图: ${JSON.stringify(diffAssert)}`)
      if (!diffAssert.ok) {
        clearTimeout(killer)
        return fail(`差值热图不符预期: ${JSON.stringify(diffAssert)}`)
      }

      // a.13) 录制状态机（先配置后开录 + 立即停止）：按钮 → S 出配置对话框（格式/画质按钮齐全、默认 video/medium）→
      //       选 GIF/低画质（持久化到 settings）→ 取消/Esc 回 idle → 再开记住上次选择 →
      //       「开始录制」→ starting 倒计时 → S 取消 → 确认采集（结果报告值）→ **S 立即停止**（无 stopping 中间态）→
      //       saving 自动弹系统保存（冒烟 IPC 模拟用户取消，留 saving）→ 保存参数与开录前一致 → 放弃回 idle；
      //       GIF 画质单元（gif-core 档位计划/尺寸上限/合成帧编码）+ a.13b 高档实采目检样本写盘（报告值）
      const gifOut = path.join(__dirname, '..', 'gif-smoke-high.gif')
      const recAssert = await win.webContents.executeJavaScript(`(async () => {
        const store = window.__twinviewStore
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const out = {}
        const S = () => store.getState()
        const click = (sel) => document.querySelector(sel)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        store.setState({ viewMode: 'single', currentId: S().images[0].id, fullscreenCell: null, physicalFullscreen: false })
        S().setRecFormat('video'); S().setRecQuality('medium') // 复位默认（冒烟 profile 可能残留上次运行值）
        await wait(300)
        out.btnShown = !!document.querySelector('[data-rec-btn]')
        // S 键 → 开录前配置对话框
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }))
        await wait(200)
        out.configPhase = S().recPhase === 'configuring'
        out.configShown = !!document.querySelector('[data-rec-config]')
        out.formatBtns = !!document.querySelector('[data-rec-format-video]') && !!document.querySelector('[data-rec-format-gif]')
        out.qualityBtns = document.querySelectorAll('[data-rec-quality]').length === 3
        out.defaults = S().recFormat === 'video' && S().recQuality === 'medium'
        // 选择 GIF + 低画质（持久化断言：localStorage settings values 同步）
        click('[data-rec-format-gif]')
        click('[data-rec-quality="low"]')
        await wait(150)
        out.picked = S().recFormat === 'gif' && S().recQuality === 'low'
        try {
          const sv = JSON.parse(localStorage.getItem('twinview.settings')).values
          out.persisted = sv.recFormat === 'gif' && sv.recQuality === 'low'
        } catch { out.persisted = false }
        // 取消 → idle；再开 → 记住上次选择
        click('[data-rec-cancel]')
        await wait(200)
        out.cancelConfig = S().recPhase === 'idle' && !document.querySelector('[data-rec-config]')
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }))
        await wait(200)
        out.remembered = S().recPhase === 'configuring' && S().recFormat === 'gif' && S().recQuality === 'low'
        // Esc 关闭配置对话框回 idle
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await wait(200)
        out.escCancel = S().recPhase === 'idle' && !document.querySelector('[data-rec-config]')
        // 「开始录制」→ starting 倒计时
        S().toggleRecord()
        await wait(150)
        click('[data-rec-start]')
        await wait(200)
        out.startingPhase = S().recPhase === 'starting'
        const pill0 = document.querySelector('[data-rec-pill]')
        out.pillShown = !!pill0 && pill0.textContent.includes('后开始录制')
        // 倒计时内 S → 取消开始
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }))
        await wait(200)
        out.cancelStart = S().recPhase === 'idle'
        // 再次配置→确认并快进到采集（headless 下采集成败只报告不断言）
        S().toggleRecord()
        await wait(150)
        S().confirmRecConfig()
        await wait(150)
        store.setState({ recCountdown: 1 })
        await wait(1600)
        out.afterCountdown = S().recPhase
        out.captureOk = S().recPhase === 'recording'
        if (!out.captureOk) store.setState({ recPhase: 'recording' })
        // 录制 1.2s 攒帧后停止 = **立即停止**：轮询相位序列，断言无 stopping 中间态且直接落 saving
        await wait(1200)
        S().toggleRecord()
        const seen = new Set(['recording'])
        for (let i = 0; i < 40; i++) {
          if (S().recPhase !== 'recording') break
          await wait(50)
          seen.add(S().recPhase)
        }
        seen.add(S().recPhase)
        out.noStopping = !seen.has('stopping')
        out.afterStop = S().recPhase // 真会话 → 'saving'；无会话 → 'idle'
        out.stopImmediate = out.afterStop === 'saving' && out.noStopping
        if (S().recPhase !== 'saving') {
          store.setState({ recPhase: 'saving', recBlob: new Blob(['x']), recMime: 'video/mp4' })
        }
        await wait(400)
        // 保存参数与开录前选择一致（GIF/低画质），叠层明示参数，不再询问格式/画质
        out.paramsKept = S().recFormat === 'gif' && S().recQuality === 'low'
        out.dialogShown = !!document.querySelector('[data-rec-save]')
        const paramsEl = document.querySelector('[data-rec-save-params]')
        out.saveParamsShown = !!paramsEl && paramsEl.textContent.includes('GIF') && paramsEl.textContent.includes('低')
        out.noReask = !!document.querySelector('[data-rec-save]') && !document.querySelector('[data-rec-save] [data-rec-quality]')
        // 放弃录制 → idle
        click('[data-rec-discard]')
        await wait(200)
        out.discarded = S().recPhase === 'idle' && !document.querySelector('[data-rec-save]')
        // GIF 画质单元：计划档位（fps/环形帧数/色数/抖动）+ 尺寸上限与字节预算 + 合成渐变帧编码出合法 GIF
        const core = await import('/src/lib/gif-core.ts')
        const gp = core.GIF_PLANS
        out.planTiers = gp.high.fps === 15 && gp.medium.fps === 12 && gp.low.fps >= 8 && gp.low.fps <= 10 &&
          gp.high.maxFrames === 300 && gp.medium.maxFrames === 360 && gp.low.maxFrames === 240 &&
          gp.high.colors === 256 && gp.medium.colors === 192 && gp.low.colors === 128 &&
          gp.high.dither === true && gp.medium.dither === true && gp.low.dither === false
        const dim1 = core.gifFrameDims(2000, 1000, 'high')
        const dim2 = core.gifFrameDims(1000, 500, 'high')
        out.planDimsCap = dim1.w === 1280 && dim1.h === 640 && dim2.w === 1000 && dim2.h === 500
        out.planEffFrames = core.gifEffectiveMaxFrames(1280, 720, 'high') === 300
        const SW = 64, SH = 48, sframes = []
        for (let f = 0; f < 6; f++) {
          const dd = new Uint8ClampedArray(SW * SH * 4)
          for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
            const ii = (y * SW + x) * 4
            dd[ii] = Math.round((255 * x) / (SW - 1)); dd[ii + 1] = Math.round((255 * y) / (SH - 1))
            dd[ii + 2] = Math.round((255 * f) / 5); dd[ii + 3] = 255
          }
          sframes.push(dd)
        }
        const synthBlob = await core.encodeGifFrames(sframes, SW, SH, 'high')
        const synthBuf = new Uint8Array(await synthBlob.arrayBuffer())
        out.gifEncodes = synthBlob.size > 0 && synthBuf[0] === 0x47 && synthBuf[1] === 0x49 && synthBuf[2] === 0x46
        // 复位（含持久化默认值还原）
        S().setRecFormat('video'); S().setRecQuality('medium')
        store.setState({ viewMode: 'browse', recPhase: 'idle' })
        S().setViewMode('browse')
        await wait(200)
        // a.13b) 高档 GIF 实采目检样本（报告值，不进 ok）：渐变测试图 → 真采集 2.5s → encodeGif('high') → 写盘
        try {
          const rec = await import('/src/lib/recorder.ts')
          const grad = S().images.find((e) => e.name.includes('grad'))
          store.setState({ viewMode: 'single', currentId: (grad || S().images[0]).id, fullscreenCell: null, physicalFullscreen: false })
          await wait(900)
          await rec.startCapture('high')
          await wait(2500)
          await rec.stopCapture()
          out.gifHighFrames = rec.gifFrameCount()
          const hiBlob = await rec.encodeGif('high')
          const hiBuf = new Uint8Array(await hiBlob.arrayBuffer())
          out.gifHighMagic = hiBuf[0] === 0x47 && hiBuf[1] === 0x49 && hiBuf[2] === 0x46
          const wr = await window.twinview.writeBinaryFile(${JSON.stringify(gifOut)}, await hiBlob.arrayBuffer())
          rec.clearSession()
          out.gifHighSaved = !!(wr && wr.ok)
          out.gifHighBytes = hiBlob.size
        } catch (e) {
          out.gifHighSaved = false
          out.gifHighError = String((e && e.message) || e)
        }
        store.setState({ viewMode: 'browse' })
        S().setViewMode('browse')
        await wait(200)
        out.ok = out.btnShown && out.configPhase && out.configShown && out.formatBtns && out.qualityBtns &&
          out.defaults && out.picked && out.persisted && out.cancelConfig && out.remembered && out.escCancel &&
          out.startingPhase && out.pillShown && out.cancelStart &&
          out.noStopping && out.stopImmediate &&
          out.paramsKept && out.dialogShown && out.saveParamsShown && out.noReask && out.discarded &&
          out.planTiers && out.planDimsCap && out.planEffFrames && out.gifEncodes
        return out
      })()`)
      console.log(`[SMOKE] 录制状态机: ${JSON.stringify(recAssert)}`)
      if (!recAssert.ok) {
        clearTimeout(killer)
        return fail(`录制状态机不符预期: ${JSON.stringify(recAssert)}`)
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
    // Windows 支持 openFile+openDirectory 并用（同一对话框可选文件或文件夹）；
    // 其他平台保持 openDirectory（选中文件 = 打开所在文件夹并定位由渲染端处理）
    const result = await dialog.showOpenDialog(win, {
      title: '选择图片文件夹或图片文件',
      properties: process.platform === 'win32' ? ['openDirectory', 'openFile'] : ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const p = result.filePaths[0]
    let isFile = false
    try {
      isFile = (await fs.stat(p)).isFile()
    } catch {
      /* 按目录处理 */
    }
    return { path: p, isFile }
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

  // 录制：取本窗口的 desktopCapturer 源 id（按窗口标题匹配，找不到回退第一个窗口源）
  ipcMain.handle('get-window-source-id', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })
    if (!sources || sources.length === 0) return null
    const title = win ? win.getTitle() : ''
    const hit = sources.find((s) => s.name === title) || sources.find((s) => s.name.includes('TwinView'))
    return (hit || sources[0]).id
  })

  // 录制：保存对话框（默认文件名 + 格式过滤），返回绝对路径或 null（取消）
  ipcMain.handle('rec-save-dialog', async (event, defaultName, extLabel, ext) => {
    // 冒烟模式：直接返回 null（模拟用户取消路径选择），避免 headless 下原生对话框卡死
    if (process.env.TWINVIEW_SMOKE) return null
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const r = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [{ name: extLabel, extensions: [ext] }],
    })
    return r.canceled || !r.filePath ? null : r.filePath
  })

  // 录制：写二进制文件（渲染进程 blob → ArrayBuffer 经结构化克隆传入）
  ipcMain.handle('write-binary-file', async (_event, filePath, data) => {
    try {
      if (typeof filePath !== 'string' || !filePath) return { ok: false, error: '路径无效' }
      const buf = Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data))
      await fs.writeFile(filePath, buf)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) }
    }
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

  // 目录图片预览：默认递归扫描（20000 项防爆上限），返回总数与前 limit 张；
  // shallow=true 时只列**本层**：count/图片均为本层（不递归），并附子文件夹条目 dirs（文件夹图标+名称用）
  const PREVIEW_SCAN_CAP = 20000
  ipcMain.handle('dir-image-preview', async (_event, dir, limit, shallow) => {
    const cap = typeof limit === 'number' && limit > 0 ? Math.min(limit, 64) : 12
    if (shallow) {
      const images = []
      const dirs = []
      let count = 0
      let entries = []
      try {
        if (typeof dir === 'string' && dir) entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return { count: 0, capped: false, images, dirs }
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
      for (const ent of entries) {
        const full = path.join(dir, ent.name)
        try {
          if (ent.isDirectory()) {
            dirs.push({ name: ent.name, path: full })
          } else if (ent.isFile() && IMAGE_EXTS.has(path.extname(ent.name).toLowerCase())) {
            count += 1
            if (images.length < cap) images.push({ path: full, name: ent.name })
          }
        } catch {
          // 跳过无权限/损坏项
        }
      }
      return { count, capped: false, images, dirs }
    }
    const images = []
    let count = 0
    let capped = false
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
