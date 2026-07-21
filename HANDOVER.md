# TwinView 维护者交接文档（HANDOVER）

> 本文供下一位维护者（或接手子代理）快速上手。**全部内容已对照磁盘真实代码撰写**；
> 若代码与本文冲突，以代码为准并更新本文。修改规约见文末，**务必先读再改**。

---

## 1. 架构总览

```
┌──────────────────────────── 渲染进程（React 19 + TS）────────────────────────────┐
│ App.tsx（布局骨架 + 导航集合 reconcile + fullscreenchange 同步）                  │
│  ├─ Toolbar（模式/排序/布局/重采样/开关）                                         │
│  ├─ Sidebar（文件夹树 / 收藏 / ALT 取样记录）                                     │
│  ├─ ThumbnailGrid（面包屑 + 子文件夹卡片 + 图标/列表四档 + 右键文件操作）          │
│  ├─ SingleView ─┐                                                               │
│  ├─ CompareView ─┼── ViewerPane（双缓冲帧模型 / 缩放平移 / wipe / ALT 探针）      │
│  ├─ CompareGrid ─┘        │                                                     │
│  ├─ Filmstrip（导航条）   ├─ decode-cache（1GB 字节预算 LRU + pin + peekDecoded） │
│  ├─ InfoOverlay ── image-info（直方图/EXIF） ──┤                                 │
│  │                       pixel-probe（ALT 探针离屏 canvas） ┘                    │
│  └─ HelpOverlay / StatusBar / FullscreenMiniBar / FileOpsMenu / EmptyState       │
│                                                                                  │
│ store/appStore.ts（zustand 单一 store）◄── hooks/useKeyboard.ts（全局快捷键）     │
│ lib/fs-provider.ts：BrowserFSProvider ⇄ ElectronFSProvider（运行时探测）          │
└──────────────────────────────────────┬───────────────────────────────────────────┘
                                       │ contextBridge（window.twinview，contextIsolation）
┌──────────────────────────────────────┴───────────────────────────────────────────┐
│ 主进程 electron/main.cjs（CommonJS）                                              │
│  窗口/菜单 ｜ twinview:// 自定义协议 ｜ IPC × 8 ｜ TWINVIEW_SMOKE=1 冒烟测试       │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### 主进程 IPC 清单（preload `window.twinview` 一一对应）

| IPC channel | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `select-directory` | — | `{path, isFile} \| null` | 系统选择框；win32 `openFile`+`openDirectory` 并用（文件/文件夹均可选），其他平台仅 openDirectory |
| `cli-open`（主→渲染 push） | `{kind, paths, flags, isFile}` | — | **非 invoke**：`webContents.send` 下发 CLI 指令（首次启动参数与 second-instance 转发同源）；preload `onCliOpen(cb)` 订阅，返回取消函数 |
| `scan-directory` | `(dir: string, recursive: boolean)` | `{path,name,size,lastModified}[]` | 递归收集图片（扩展名白名单 11 种）；无权限项跳过 |
| `list-dirs` | `(dir: string)` | `{name,path,imageCount,hasSubdirs}[]` | 一层子目录（文件夹树懒加载；imageCount 为本层直接图片数） |
| `path-ancestors` | `(dir: string)` | 同上（root-first，不含自身） | 祖先链，最多 64 级；`hasSubdirs` 恒 true |
| `read-file-buffer` | `(filePath: string)` | `Uint8Array \| null` | 渲染端转 blob 解码（分析层）；**>512MB 抛错** |
| `copy-files` | `(sources: string[], targetDir: string)` | `{ok: string[], failed: {name,error}[]}` | 重名自动 `- 副本` / `- 副本 (n)` |
| `make-dir` | `(parent: string, name: string)` | `{ok: boolean, error?: string}` | 非法字符 `\/:*?"<>\|` 与重名校验 |
| `trash-items` | `(paths: string[])` | `{ok, failed}` | `shell.trashItem` 进回收站 |
| `set-window-background` | `(color: string)` | `void` | 主题同步窗口背景（#rrggbb 校验） |
| `special-dirs` | — | `{name,path}[]` | 打开对话框快捷入口：桌面/图片/文档/下载/主目录 + win32 枚举 C–Z 盘符 |
| `browse-dir` | `(dir: string \| null)` | `{path, parent, dirs}` | null → 顶层盘符/根；否则列一层子目录（复用 listDirsLayer） |
| `dir-image-preview` | `(dir: string, limit: number, shallow?: boolean)` | `{count, capped, images[], dirs?}` | 默认递归计数（20000 防爆上限）+ 前 limit 张（文件优先排序；limit ≤64）；**shallow=true 只列本层**（count/图片均本层，附 `dirs` 本层子文件夹条目） |
| `copy-into` | `(sources: string[], targetDir: string)` | `{ok, failed}` | 拖放递归复制（文件/目录；重名 `- 副本`；目录 ok 记 `name/`） |

另暴露 `platform`、`versions`、`getPathForFile`（`webUtils.getPathForFile`，拖放 File → 绝对路径）。`twinview://local/<encodeURIComponent(绝对路径)>` 由主进程 `net.fetch(pathToFileURL(...))` 提供，**仅供 `<img>` 显示**；Chromium 在 `file://` 页面禁止 fetch 自定义协议（冒烟中 fetchProbe 失败是**预期行为**），分析层一律走 `read-file-buffer` → blob。

---

## 2. 核心机制详解

### 2.1 fs-provider 双实现与探测（`src/lib/fs-provider.ts`）

- 运行时探测：`window.twinview` 存在 → `ElectronFSProvider`，否则 `BrowserFSProvider`（`getFSProvider()` 单例缓存）。
- 统一抽象 `ImageEntry`：`{id, name, path, size, lastModified, handle?, getUrl(), revoke()}`。
  - Electron：`id = 绝对路径`，`getUrl()` 返回 `twinview://` URL，`revoke()` 空操作；
  - 浏览器：`id = path::size::lastModified`，`getUrl()` 惰性创建 blob: URL，`revoke()` 释放。
- `DirectorySource`：`{name, handle?（FS Access）, files?（webkitdirectory 回退）, dirPath?（Electron）, focusFile?（系统选择器选中文件时定位用）}`，三种形态决定目录树与文件操作的实现分支。
- 浏览器打开时请求 `readwrite` 权限（文件操作需要）；Firefox/Safari 自动回退 `webkitdirectory`（只读）。

### 2.2 decode-cache 会话解码缓存（`src/lib/decode-cache.ts`）

- value：`{bitmap: ImageBitmap | null, url: blob:URL, natural: {w,h}, bytes = w×h×4}`。优先 `createImageBitmap`，失败回退 HTMLImageElement + blob URL（bitmap 为 null）。
- **字节预算 LRU**：总预算 `BYTE_BUDGET = 1GB`；命中刷新 `last` 时间戳；插入后 `evictIfNeeded()` 按最久未用淘汰（`bitmap.close()` + revoke URL）。
- **pin 保护**：`pinDecoded(id)` 返回 unpin 函数，计数 >0 不可淘汰；全部 pinned 时允许暂时超预算；unpin 时补淘汰。
- **`peekDecoded(id)`**：同步命中查询（刷新 LRU + 日志），供 ViewerPane 切图**当帧渲染**；未命中返回 null 不触发解码。
- `getDecoded(entry)`：命中秒回；未命中解码并**在途去重**（inflight Map）；`generation` 计数保证 `clearDecodeSession()` 后在途结果落地即释放、不回填。
- `preloadDecode(entries, concurrency=3)`：预取（已在缓存/在途的跳过）。
- **清空时机**（appStore 中调用，均同时 `clearProbeCache()`）：`openDirectory` / `openPath` / `rescan`；`setViewMode('browse')` 且来自 compare/grid。
- 调试：`localStorage.twinview.debugCache = '1'` → console 输出 命中 / 未命中 / 入缓存（±MB）/ 淘汰 / 清空。

### 2.3 ViewerPane 双缓冲帧模型（`src/components/ViewerPane.tsx`）

- **Frame = `{key, layers, decoded[], metas[]}`**：一帧完整画面，原子交换的最小单位。
- 切图流程（`useLayoutEffect`，deps = `layerKey` = entry.id 拼接）：
  1. 全部图层 `peekDecoded` 命中 → **同步 finish**（layout effect 内 setFrame → 当帧上屏，无 await 间隙、无黑帧）；
  2. 否则 `Promise.all(getDecoded)` 异步解码，**期间旧帧完整保留**（不清空、不卸载），就绪后一次性交换；
  3. finish 时释放旧帧 pin、转持新帧 pin（过渡期新旧同时受保护）；effect 清理时若未消费（被更快切换取代）自行释放本批 pin；组件卸载统一释放。
- **stale 判定**：`frame.key !== layerKey` 时显示旧帧；key 相同则用 props layers（叠化透明度滑块实时生效）。
- **CanvasSmooth（软件重采样路径）防抖分流**：**图像源（bitmap/img）变化立即绘制**（useLayoutEffect，pre-paint）；仅尺寸/质量变化（连续缩放）才 120ms 防抖。canvas backing store 上限 4096px。`resample` 为 BIFant/双线性/双立方/Lanczos 时：先 `imageSmoothing` 平滑预览，停手 ~150ms 后调 `resampler.ts` CPU 精确重绘（可取消，旧任务随新调度取消）。
- `<img>` 路径（自动/邻近）：`imageRendering: pixelated` 当 `resample==='nearest'` 或有效缩放 >400%。
- **ViewTransform**（appStore 定义）：`{mode: 'fit'|'free', zoom, panFX, panFY, rotation(角度制)}`。
  - 有效缩放 `oe = fit ? fitZoom : zoom`；fitZoom 按容器/图片（旋转 90/270 交换宽高）计算并夹取 **[0.02, 64]**；
  - **panFX/panFY 是渲染尺寸的分数位移**（`px = panFX × rw`），fit 模式位移恒 0；
  - 拖拽先转 free（base.zoom = 当前 fitZoom）再按 `dx/rw` 累加；滚轮以指针为锚保持图像点不动。
- **wipe 几何**：A（层 0）整幅在下，B（层 1）用 `clip-path: inset(0 0 0 ratio×100%)` 裁掉左侧 → 分割线左侧显 A、右侧显 B；分割线 x = `容器宽/2 − rw/2 + px + ratio×rw`（手柄拖拽优先于平移，ratio ∈ [0.02, 0.98] 持久化）。
- **四种布局对齐规则**：
  - 划变：两图层共享 sharedTransform，几何完全对齐（各自图宽 × 同一比例）；
  - 并排：左右两个独立 ViewerPane（splitRatio 分隔，[0.15, 0.85] 持久化）；`sync=true`（默认）共用 sharedTransform，否则各自 transformA/B；
  - 叠化：两图层同 pane 共享 transform，上层 `opacity` = overlayOpacity（工具栏滑块），`overlaySwapped` 换上下层；
  - 网格：每格独立 ViewerPane；`gridSync`（默认）共用 sharedTransform，否则 `gridTransforms[i]`。
- **ALT 探针**（ViewerPane 内）：按住 ALT → crosshair；容器坐标 →（减容器中心+位移 → 按 −rotation 反旋 → ÷ rw/rh + 0.5 → ×原图尺寸）得原图坐标；`u,v ∈ [0,1]` 才显示浮签；ALT+单击取样（拦截，不进拖拽/激活/双击）。像素来自 `pixel-probe.ts`：复用 decode-cache bitmap 一次性绘到离屏 canvas（最长边 ≤4096，按比例换算；LRU 4 张；twinview:// 兜底路径取不到值返回 null）。

### 2.4 文件操作与剪贴板（`src/lib/file-ops.ts` + `ThumbnailGrid`）

- `clipboard` = 图片 id 数组（appStore）；**粘贴 = 复制到当前目录**（currentPath 支持根内相对路径与祖先链绝对路径，`electronTargetDir` 解析）。
- 操作目标：右键项在勾选集合内 → 视野内全部勾选项；否则仅右键项。
- 重名副本命名 `copyNameOf(name, n)` 在主进程与渲染端**各有一份实现，需保持同步**。
- FS Access：操作前 `ensureReadWrite` 按需申请；删除 = `handle.remove()` 直删（Chrome 110+，不进回收站）；webkitdirectory 回退全部禁用（`writeSupported` / `writeUnsupportedReason`）。
- **系统拖放**（ThumbnailGrid 主容器 onDragOver/Leave/Drop，投放指示层提示可写性）：Electron 走 `webUtils.getPathForFile` → `copy-into` IPC（主进程递归，含目录）；浏览器 FS Access 走 `dropItemsFromDataTransfer`（`webkitGetAsEntry` 递归遍历目录，readEntries 循环读空批）→ `dropToDirectory` 递归写入（文件/目录重名都走 `copyNameOf` 副本；每 10 项更新 toast 进度）。
- 操作成功后 `rescan()`（重扫保留偏好，勾选/槽位/视图重置——见 freshState）。

### 2.5 浏览网格：子文件夹 / 面包屑 / 显示模式（`src/components/ThumbnailGrid.tsx`）

- **子文件夹条目**：当前目录的直接子文件夹（`treeChildren[currentPath]`，复用文件夹树的 `loadTreeChildren` 懒加载缓存，三种数据源行为一致）**无论 recursive 开关都显示，排在图片前**。
  - 图标档 = `FolderCard`：递归视野内前 4 张图片（按名称序）2×2 `object-cover` 拼贴（1 张占满整格），无图片时纯文件夹图标；名称 + 递归图片计数；IntersectionObserver 进入视口才 `getUrl()`。
  - 列表档 = `FolderRow`：文件夹图标 + 名称 + 「文件夹 · N」（计数列），像素尺寸/时间为 `—`；无勾选框（勾选是图片概念，勾选框只在图片行首）。
  - 交互：单击选中（组件本地 `selectedFolder`，切换目录自动清空）；**双击 = `setCurrentPath(node.relPath)` 进入**（与文件夹树同一视野机制）；右键仅「打开」（文件操作留后续）。
  - `folderEntries`：一次遍历 `images` 按 `scopeOk(e, dir, node.relPath, true)` 归入各子文件夹（同层不重叠，命中即停），供拼贴与计数；O(图片数 × 本层子文件夹数)。
- **面包屑**（`BreadcrumbBar`，网格上方固定条）：根名/逐段可点击跳转；`currentPath` 为祖先链绝对路径时分段为绝对前缀。左侧 ↑ 按钮 = `navigateUp()`（相对路径逐段回退到 `''`；绝对路径用 `absDirOf` 逐级向上）；**Backspace 同效**（useKeyboard 浏览分支）。文件夹树高亮、面包屑、网格视野共用 `currentPath`，天然一致。
- **树节点点击 = 回浏览**（第十轮）：Sidebar `TreeNode` 行点击在 `setCurrentPath(relPath)` 后追加 `setViewMode('browse')`——单图/对比/网格视图下点树即切回浏览网格（浏览中点击行为不变；`setViewMode` 自带 fullscreenCell 清理与缓存释放，Esc 链不回归）。冒烟 a.11 断言。
- **显示模式四档**（`browseMode: 'large'|'medium'|'small'|'list'`，localStorage `twinview.browseMode` 持久化）：工具栏 segmented 替代原尺寸滑块；`BROWSE_MODE_SIZE` 固定映射 大 256 / 中 168 / 小 112（`setBrowseMode` 同步写 `thumbSize`；列表档不动 `thumbSize`，切回图标档尺寸不丢）。
- **列表模式**：`ListHeader` 列头（名称/大小/修改时间可点击——同列切 `sortAsc`、异列换 `sortKey`，复用全局排序状态）+ `ImageRow`（checkbox、40px 缩略图、名称、像素尺寸、大小、修改时间）/ `FolderRow`。
  - **像素尺寸**：`<img onLoad>` 读 `naturalWidth/Height`，模块级 `dimsCache`（Map，无上限，会话内有效）避免滚动闪烁；**不经 decode-cache**（小图直读 `getUrl()`，与缩略图同策略）。
  - 图片行双击进单图、单击 `setCurrent`（isCurrent 行 `scrollIntoView` 与胶片条联动）、右键同图标档文件操作菜单；勾选行底色 `bg-sky-600/15`。

### 2.6 设置收口（`src/lib/settings.ts`）

- **单 key 持久化**：`twinview.settings` = `{version: 1, values: SettingsData}`；模块级缓存 `loadSettings()` 启动读一次，`updateSettings(patch)` 合并 + 校验 + 写盘（appStore 全部偏好 setter 走它）。
- `sanitize()` 逐字段校验（枚举白名单 / 数值夹取 / favorites 结构过滤），损坏字段回退默认；无新 key 时 `migrateLegacy()` 从旧散 key（`twinview.favorites/.splitRatio/...`）迁移一次（旧 key 保留不删）。
- **递归默认关**：`DEFAULT_SETTINGS.recursive = false`（扫描仍始终递归全扫，这只是视野默认）。
- 类型（`BrowseMode/SortKey/ResampleMode/CompareLayout/NavScope/ThemeMode`）在此定义，appStore re-export 供组件沿用旧导入路径。

### 2.7 主题三档（`src/lib/theme.ts` + `src/index.css` 变量体系）

- `applyTheme('dark'|'light'|'system')`：`dark` class 挂 `<html>`；`system` 经 `matchMedia('(prefers-color-scheme: dark)')` 监听系统切换；Electron 下同步 `set-window-background` IPC（防亮主题白闪）。
- `index.css` 定义 `--tv-*` 语义变量双套（`:root` 亮 / `.dark` 暗）：`--tv-bg/panel/panel2/card/well/overlay/input/text/text-dim/text-faint/soft/hover/line`；组件一律用 `bg-[var(--tv-*)]` / `text-[var(--tv-*)]`，**禁止再写 `bg-neutral-900` 这类硬编码**。
- **有意保留的固定色**：黑色浮层族（ViewerPane 标题/探针浮签、InfoOverlay、toast）固定 `bg-black/..` + `text-neutral-200`；wipe 手柄固定浅色。新增浮层注意归类。
- `index.html` 内联首帧防闪脚本：paint 前读 `twinview.settings` 预置 `dark` class（system 按 matchMedia 求值）。

### 2.8 软件重采样（`src/lib/resampler.ts`）

- 可分离两遍卷积：水平 `sw×sh → tw×sh`（Float32 中间缓冲）→ 垂直 `→ tw×th`；某一维尺寸不变则跳过该遍。
- 核：BIFant 盒式（support 0.5，**area 模式**）/ 双线性三角（1）/ 双立方 Catmull-Rom a=-0.5（2）/ Lanczos-3 sinc 窗（3）；缩小时核按 1/scale 加宽抗混叠；权重按输出像素预计算 `{start, weights}` 并归一化。
- **BIFant 权重 = 覆盖长度（真 Fant，第九轮修复）**：输出像素源足迹 `[center±support]` 与源像素 `[p, p+1]` 的覆盖长度为权重（边缘像素按比例部分计入）。此前是 all-or-nothing（像素中心落入足迹即全权重、否则 0），且贡献窗把像素当整数点而非中心 p+0.5（整体右偏 0.5px）——轻微缩小（≥0.78）时足迹 1~1.3px，边缘像素跳入/跳出产生周期性横竖线；放大时单贡献像素中心距 >0.5 被清零成**全黑像素**（周期黑线，实测 meanErr 高达 46~71 灰级）。非面积核贡献窗相应修为 `[center±(support+0.5)]`（多收像素权重自然为 0，不错漏）。
- 回归校验：`npm run verify:bifant` = tsc 编译 resampler.ts 到 `.verify-tmp/` + `node scripts/verify-bifant.mjs`（合成对角渐变+2px 网格，50/78/100/150% 跑 `resamplePixels`，断言行列均值尖峰比 ≤2.5、全局均值漂移 ≤1 灰级；输出 PGM/PNG 供目检）。`resamplePixels` 为无 DOM 纯函数，与 `resampleTo` 共用 contribs + `hPassRange`/`vPassRange` 行区间卷积。
- 分片（256 行）`setTimeout(0)` 让出主线程；`ResampleHandle.cancel()` 取消（ViewerPane 调度新任务前取消旧的）；LRU 8 张（key = `条目id|算法|宽x高`，ImageBitmap，`clearResampleCache()` 全清）。
- 源像素：decode-cache 的 bitmap 画离屏 canvas 取 `getImageData`（同探针链路，不污染 canvas）。

### 2.9 打开文件夹对话框（`OpenFolderDialog.tsx`，**选择即打开**）

- **Electron**（`openDirectory()` → `setOpenFolderDialog(true)`）：左栏 = `special-dirs` 快捷入口 + `browse-dir` 子目录列表（含 ↑ 上级）；右栏 = `dir-image-preview(dir, 12, /* shallow */ true)` **本层预览**——子文件夹 tile（FolderIcon+名称，单击进入）排前 + 本层图片缩略图（twinview://），**计数按本层不递归**（第八轮起；此前递归计数很乱）。**子文件夹单击 = 选中（高亮 + 预览该目录），双击 = 进入**；「打开此文件夹」对选中项（无选中则当前位置）经 `openPathFocus` 直接生效，**无二次确认/中间态**（本层无图也可打开——子目录可能有图，由 recursive 开关决定扫描视野）。「系统对话框选择…」走 `select-directory`（win32 文件/文件夹均可选；选中文件 → `focusFile` → 打开所在文件夹并定位选中）。
- **浏览器**：`openDirectory()` pick + 扫描后直接打开（第五轮的「选择后确认条」`PendingOpenConfirm` 已删除；`pendingOpen` state 与 confirm/discard actions 一并移除）。

### 2.10 CLI 与单实例（`electron/main.cjs` + `appStore.applyCliOpen`）

- **解析**：`parseCliArgs(argv)` 纯函数——位置参数（首个为 folder）、`--compare A B`、`--recursive`、`--theme dark|light|system`、`--layout wipe|side|overlay|grid`、`--help/-h`；未识别参数进 `warnings`（stdout 警告忽略）。argv 截取：`app.isPackaged ? slice(1) : slice(2)`（`selfCliArgv()`），容忍前导 `--`。
- **下发**：`dispatchCli(argv, win)` 打印 warnings/help → `fs.stat` 判型（folder 的 isFile；compare 校验两文件存在）→ `webContents.send('cli-open', payload)`（窗口加载中则等 did-finish-load）。首次启动在 `whenReady` 后 dispatch（SMOKE 跳过，由冒烟自行注入）。
- **单实例**：`requestSingleInstanceLock()`（SMOKE 跳过锁以便并行自检）；未持锁进程 `app.quit()`，持锁方 `second-instance` → 窗口 restore/focus + 转发新 argv 走同一 dispatchCli。主 `whenReady` 块也加了持锁守卫（防未持锁进程仍建窗）。
- **渲染端**：`App.tsx` 订阅 `provider.onCliOpen` → `applyCliOpen(payload)`：flags 先应用（setTheme/setRecursive）→ folder 走 `openPathFocus`（文件时 absDirOf + 按绝对路径匹配选中 currentId）→ compare 计算 A/B 最深公共目录（盘符不同回退 A 所在目录）openPath 后按绝对路径匹配两图入槽；`--layout grid` 进网格（gridIds=[A,B]），否则进 compare（B 缺失仅设 A 槽 + ensureSlots + warn）。全程**不走任何确认弹窗**。
- **dev 用法**：`npm run electron:cli -- <args>`（package.json 脚本 = `wait-on http://localhost:7100 && electron . --`）；`npm run electron:dev -- <args>` 不透传（concurrently 把参数当自身位置参数）。
- **Kimi Work skill**：注册位置 `daimon-share/daimon/skills/twinview/SKILL.md` + 仓库副本 `skills/twinview/SKILL.md`，**两处内容需同步**（规约第 7 条）。

### 2.11 全屏策略、真全屏布局与槽位导航（App.tsx / appStore.navigate / fullscreenDblClick）

- **双击三层交互链（第九轮恢复，单格语义）**：`fullscreenCell` 恢复单格语义 = `'single' | 'A' | 'B' | 格索引 string | null`。新增 action `fullscreenDblClick(cell)` 实现状态机：**L0** 原布局 →（双击格 / F）→ **L1** 单格控件全屏（`fullscreenCell=该格`，App 层 `hideChrome` 隐藏侧栏+胶片条，视图切单格分支：单 ViewerPane + InfoOverlay + `FullscreenMiniBar`）→（双击）→ **L2** 物理全屏（Fullscreen API，`fullscreenCell` 保持）→（双击）→ **L3** 循环切换全屏显示源：对比 A↔B、网格格索引 +1 循环（**槽位 / 格组内容本身不变**，只切显示哪一格；单图无源可切，L3 无操作——单图双击仍是适应 ↔ 100%）。wipe/叠加组合格双击 = `fullscreenDblClick(activeSlot)`（进激活槽单图）。Esc 顺序不变：physical → fullscreenCell → browse。**第八轮的"视图级全屏"（'compare'/'grid' 整控件全屏）已移除**（用户要求恢复经典双击链）。
- **F / Shift+F**：F = 单图 / 对比激活格 / 网格当前格的控件全屏开关（即链的 L1，`setFullscreenCell` 往返）；Shift+F = 当前视图整体直进物理全屏（不补标 fullscreenCell）。**物理全屏且无 fullscreenCell 时**（Shift+F 直进），由各视图**普通分支**渲染 `FullscreenMiniBar` 提供退出入口（SingleView/CompareView/CompareGrid 均已加 `{physicalFullscreen && <FullscreenMiniBar … onExit={() => setFullscreenCell(null)} />}`）。
- **物理全屏 = 真全屏**：`physicalFullscreen=true` 时 App 层**卸载**工具栏（`[data-chrome="toolbar"]`）、侧栏（`<aside>`）、胶片条（`[data-chrome="filmstrip"]`）——不修改 `sidebarOpen/filmstripOpen` 本身，退出后**自然恢复**原面板可见性；保留图像 + InfoOverlay/直方图（若开启）+ 悬浮迷你条（含「退出物理全屏」按钮）。`fullscreenchange` 事件同步 store（Esc 退出同样恢复布局）。ViewerPane 根带 `[data-view-pane]` 供冒烟计数；`fullscreenDblClick` 的 grid L3 分支对 `parseInt(fullscreenCell)` NaN 取 base=-1（下一格为 0）。
- **对比/网格 ←/→ 槽位导航**：`navigate(delta)` 内 `stepIdSkipping(id, skip)` 泛化第五轮的 stepIdSkip——对比模式作用于**激活槽位**（优先跳过另一槽占据项），网格模式作用于**激活格**（优先跳过其他格占据项）；**跳过后无目标时回退为不跳过**（`stepId` 正常步进，允许与另一槽/其他格同图，如仅勾选 2 张占满 A/B）；集合仅 1 张且当前就在该图时静默 noop（无提示）。导航范围由 `getNavList` 遵循「全部/仅勾选」。网格分支**直接写 gridIds** 而非 `setGridCellImage`——后者对「目标已在其他格」做交换（胶片条指派语义），回退同图场景需允许重复；正常跳过路径下两者等价。
- **showNotice 机制保留**：`notice` state + `showNotice(msg)`（3s 模块级计时器自动消失，App 根 `[data-notice]` 浮签）当前无调用方，留作后续一次性提示通道。X 交换、N 下一对/下一组不变。

### 2.12 差值热图布局（diff，`src/lib/diffmap.ts` + `src/components/DiffPane.tsx`，第十一轮）

- `CompareLayout` 第 4 档 `'diff'`（持久化）；**D 键 = `toggleDiffLayout()`**：进入 diff 记录 `diffPrevLayout`（会话级），再按 D 还原；W/G `cycleCompareLayout` 仍只在 划变→并排→叠化 三档循环（diff 档时回划变）。工具栏 segmented 加「差值」档；**配置面板仅 diff 激活时显示**（`[data-diff-panel]`）：colormap 下拉 + 容差滑块/数值输入（0–128，默认 16），`diffColormap/diffTolerance` 持久化到 settings。
- **计算**（`computeDiffBitmap(bmpA, bmpB, tolerance, colormap)`）：公共采样网格 = **A 的自然尺寸**，B 经 canvas 平滑缩放到 A 尺寸（`toImageData`）；逐像素差值 = **三通道最大 abs diff**（max(|Δr|,|Δg|,|Δb|)，非欧氏距离——对通道级错位更敏感、计算更省）；**diff ≤ 容差 → 黑色**；否则 `(diff-容差)/(255-容差)` 归一 → 256 级 LUT。LUT：inferno/viridis = matplotlib 锚点分段线性插值近似（视觉与原 LUT 一致），gray 线性，coolwarm = (59,76,192)→(221,221,221)→(180,4,38) 发散。数据源 = decode-cache bitmap（blob 解码，canvas 不污染）。
- **DiffPane**：交互与 ViewerPane 对齐（滚轮锚点缩放/拖拽平移/双击走 fullscreenDblClick(activeSlot)/旋转），transform 用 `sharedTransform`；**重算仅发生在源图/容差/colormap 变化**（100ms 防抖），缩放平移只 drawImage 已算好的 diff bitmap（不重算）。diff bitmap 旧帧持有至新帧就绪（close 旧帧防泄漏）；A/B pinDecoded 与 ViewerPane 同规则。**ALT 探针在 diff 下不支持**（合成图坐标会误导）。显示 canvas 带 `[data-diff-canvas]` 供冒烟读像素。
- 冒烟 a.12：UI 挂载（面板+canvas）→ 同图（A1 vs A1）中心像素全黑 → 异图非黑 → 容差滑块存在且拖动联动 store（native setter + input 事件）→ 面板仅 diff 布局可见（切并排隐藏、切回显示）→ 单元级（动态 `import('/src/lib/diffmap.ts')` + 合成 4×4 位图，d=100 恒定）：容差 16→64 灰度值单调下降、容差 100 全黑、gray 输出与 LUT 抽查均 R=G=B（消色差）、coolwarm LUT 中点近白且左端偏蓝/右端偏红、四种必需 colormap 单一来源列表齐全有序且均可切换生效、inferno≠viridis。
- 第十二轮补强：colormap 可选列表单一来源化——`settings.ts` 导出 `DIFF_COLORMAP_VALUES = ['inferno','gray','viridis','coolwarm']`（顺序即下拉顺序，四种必需色带在前），设置校验、工具栏下拉（`DIFF_COLORMAPS` 由其派生 + 标签映射）、冒烟 a.12 三处共用，杜绝三处列表漂移。

### 2.13 显示区录制（`src/lib/recorder.ts` + `src/lib/gif-core.ts` + `RecordOverlay.tsx` + store rec*，第十一轮起）

- **状态机**（store，第十二轮**先配置后开录**、第十三轮**停止立即化**）：`idle → configuring(开录前配置) → starting(3s 倒计时) → recording → saving(系统保存对话框) → idle`；S 键/工具栏按钮 = `toggleRecord()`：idle→configuring、starting→取消回 idle、**recording→立即 `finalizeCapture()` 进 saving（无停止倒计时）**（configuring/saving 中 S 无效）。配置对话框「开始录制」= `confirmRecConfig()`（进 starting 倒计时），「取消」/ Esc = `cancelRecConfig()`（Esc 在 useKeyboard 全局链最前端拦截 configuring）。倒计时 tick 用模块级 `recTickTimer`（store.setState({recCountdown}) 可被冒烟快进）；`recElapsedTimer` 驱动红点徽标计时；**10 分钟上限** `recMaxTimer` 自动 finalize。`setViewMode` 入口先 `stopRecordingCleanup()`（视图切换一律停止并释放 tracks，configuring 态同被覆盖）。
- **开录前配置**（`recFormat/recQuality` **持久化**到 settings，默认取上次选择）：格式 视频(MP4/WebM 按 `pickVideoMime()` 实时探测标注)/GIF + 画质 高/中/低；MP4 不可用与「GIF 10fps 最多 30 秒」等提示在配置对话框展示。**停止后不再询问格式/画质**：`finalizeCapture` 进 saving 即自动 `saveRecording()` 弹系统保存对话框选位置；用户取消路径选择/保存失败则留 saving，叠层提供「重试保存 / 放弃录制」。
- **采集**：Electron = IPC `get-window-source-id`（desktopCapturer 按窗口标题匹配）→ `getUserMedia({video:{mandatory:{chromeMediaSource:'desktop', chromeMediaSourceId}}})`；浏览器 = `getDisplayMedia`（限制见 README）。隐藏 `<video>` 播流 → **镜像 canvas 按 `<main>` rect 裁剪**（15fps，videoWidth/innerWidth 换算设备像素）→ `captureStream(15)`。
- **编码**：MediaRecorder mime 运行时探测（`video/mp4;codecs=avc1…` → `video/mp4` → `webm/vp9` → `webm`），**MP4 不可用落 WebM 且 UI 明示**；**码率按画质档于录制开始确定**（高8/中4/低2 Mbps；开录后改画质只影响下次录制——已知折衷）。**GIF（第十三轮重写，`src/lib/gif-core.ts` 纯函数核心）**：录制时按档采集——**高 15fps/≤1280 宽/300 帧（20s）、中 12fps/≤720 宽/360 帧（30s）、低 8fps/≤480 宽/240 帧（30s）**（`GIF_PLANS`；高档 300 帧 720p RGBA ≈1.1GB，`GIF_MAX_BYTES` 1.25GB 预算缩帧兜底）；编码 = **rgb888 全局调色板**（多帧抽样一次 `quantize(format:'rgb888')`，避免默认 rgb565 粗采样丢色阶；逐帧建板会色闪）+ 32³ 3D LUT 最近色映射 + **高/中档 Floyd–Steinberg 误差扩散抖动**（gifenc 无内置 dither，自实现；低档直映射省 CPU）；首帧写全局板后续帧复用，`repeat:0` 无限循环。旧路径（360 宽/10fps/rgb565 逐帧/无抖动）基准对比见第十三轮汇报：同 6s 素材 1.08MB→16.7MB（960 宽），渐变块伏色带消除。
- **保存**：按开录前选择执行（GIF 先 gifenc 编码）→ Electron `rec-save-dialog`（showSaveDialog）→ `write-binary-file` IPC（blob→ArrayBuffer→fs.writeFile）；浏览器只能 a[download] 触发下载。放弃 = `discardCapture()` 释放全部资源。**`rec-save-dialog` 在 `TWINVIEW_SMOKE` 下直接返回 null**（模拟用户取消，防 headless 原生对话框卡死）。
- **RecordOverlay**：挂在 App 显示区列（`relative` + absolute 叠层）：configuring 模态 `[data-rec-config]`（`[data-rec-format-video/gif]`、`[data-rec-quality]`、`[data-rec-start]`（autoFocus）、`[data-rec-cancel]`）、starting 中央胶囊 `[data-rec-pill]`（「3S 后开始录制·再按 S 取消」）、recording 右上红点徽标 `[data-rec-badge]`、saving 模态 `[data-rec-save]`（参数明示 `[data-rec-save-params]` + `[data-rec-save-ok]` 重试 / `[data-rec-discard]` 放弃）。
- IPC 新增 ×3：`get-window-source-id` / `rec-save-dialog` / `write-binary-file`（preload 同名透传，TwinviewBridge 类型同步）。
- 冒烟 a.13（不断言真实编码）：S 事件进 configuring + 配置对话框（格式/画质按钮、默认 video/medium）→ 选 GIF/低画质并断言 **localStorage 持久化** → 取消/Esc 回 idle → 再开记住上次选择 → 「开始录制」进 starting + 胶囊 → S 取消 → 确认快进倒计时 → **headless 下真实采集成功**（`captureOk:true`）→ 录制 1.2s 攒帧 → **S 立即停止**（轮询相位序列断言 `noStopping` 无中间态且 `stopImmediate` 落 saving）→ 自动保存被冒烟 IPC 模拟取消留 saving → **保存参数与开录前一致**（store gif/low + 叠层参数文案 + 无重复询问按钮）→ 放弃回 idle；**GIF 单元**（动态 import gif-core：档位计划 fps/帧数/色数/抖动、尺寸上限、字节预算帧数、合成渐变帧编码出 GIF89a 合法头）；a.13b 高档实采 2.5s（渐变测试图）→ `encodeGif('high')` → 写盘 `gif-smoke-high.gif`（报告值，供人工目检）；采集成败与 afterStop/gifHigh 仅报告不断言，saving 态无会话时用假 blob 兜底断言。

---

## 3. 状态管理（`src/store/appStore.ts`，zustand 单一 store）

**state 分组**：
- 目录与列表：`providerKind, dir, loading, loadError, images, recursive, currentPath, treeChildren, treeExpanded, ancestors`
- 打开对话框：`openFolderDialogOpen`（Electron 自绘对话框）
- 视野与排序：`formatFilter, sortKey, sortAsc, thumbSize, browseMode`；勾选/剪贴板：`checked, clipboard`
- 视图：`viewMode('browse'|'single'|'compare'|'grid'), currentId, fullscreenCell('single'|'A'|'B'|格索引，单格控件全屏), physicalFullscreen`
- 提示：`notice`（一次性操作提示，showNotice 设置，3s 自动消失；当前无调用方，机制保留）
- A/B：`slotA, slotB, activeSlot, compareLayout('wipe'|'side'|'overlay'|'diff'), sync, splitRatio, wipeRatio, overlayOpacity, overlaySwapped, transformA, transformB, sharedTransform`
- 差值：`diffColormap, diffTolerance（持久化）, diffPrevLayout（会话级）`
- 录制：`recPhase('idle'|'configuring'|'starting'|'recording'|'saving'), recCountdown, recElapsed, recMime, recBlob`（会话级）；`recFormat, recQuality`（**持久化**，开录前配置默认取上次选择）
- 网格：`gridIds, gridActiveIdx, gridSync, gridLayout, gridTransforms`；单图：`singleTransform`
- 开关：`navScope, resample, theme, infoVisible, histoVisible, sidebarOpen, filmstripOpen, helpOpen`
- 收藏/取样：`favorites({path,addedAt}[]), samples(SampleRecord[]，≤10 条，seq 自增)`

**Action 分组**：打开/扫描（`openDirectory/openPath/openPathFocus/applyCliOpen/rescan/loadTreeChildren/loadAncestors/toggleTreeNode`）；视野（`setRecursive/setCurrentPath/navigateUp/setFormatFilter/setSortKey/toggleSortAsc/setThumbSize/setBrowseMode`）；勾选（`toggleChecked/checkAll/clearChecked/setClipboard`）；导航（`setViewMode/setCurrent/enterSingle/navigate/reconcileNav`）；A/B（`startCompareFromChecked/ensureSlots/setSlot/assignCurrentToSlot/swapSlots/toggleActiveSlot/nextPair/setCompareLayout/cycleCompareLayout/toggleDiffLayout/setDiffColormap/setDiffTolerance/setSync/setSplitRatio/setWipeRatio/setOverlayOpacity/toggleOverlaySwapped`）；网格（`setGridLayout/setGridSync/setGridActiveIdx/setGridCellImage/setGridTransform/nextBatch`）；变换（`setSingleTransform/setSharedTransform/setTransformA/setTransformB/rotateCurrent/resetView`）；偏好（`setNavScope/setResample/setTheme/toggleInfo/toggleHisto/toggleSidebar/toggleFilmstrip/toggleHelp`）；全屏/取样（`setFullscreenCell/togglePhysicalFullscreen/addSample/clearSamples`）；录制（`toggleRecord/beginCapture/finalizeCapture/setRecFormat/setRecQuality/saveRecording/cancelSave/stopRecordingCleanup`）；收藏（`addFavorite/removeFavorite`）；清理（`revokeAll`）。

**导出辅助**：`newTransform()`、`getVisibleImages(q)`（scopeOk + 格式过滤 + 排序）、`getNavList(q)`（再按 navScope==='checked' 过滤）、`preloadCurrentContext(s)`（内部：按当前视图预解码——compare=[A,B]、grid=全部格、single=当前±1）、`BROWSE_MODE_SIZE`（图标三档固定尺寸映射）。

**持久化**：全部偏好收口在单 key `twinview.settings`（见 §2.6；仅调试开关 `twinview.debugCache` 独立）。`freshState(dir, images)` 在打开/重扫时重置浏览状态但**保留全部偏好**。dev 构建下 store 暴露为 `window.__twinviewStore`（冒烟 UI 自动化与控制台调试；生产构建由 Rollup 消除）。

---

## 4. 数据流：打开文件夹 → 看图

1. `openDirectory()` → `provider.pickDirectory()` → `listImages(dir, recursive=true)`（**始终递归全扫**，「含子文件夹」只是视野开关）→ `revokeAll()` + `clearDecodeSession()` + `clearProbeCache()` → `set(freshState(...))` → `loadAncestors()`。
2. Sidebar 根层预载 `loadTreeChildren('')`；展开节点懒加载（Electron `list-dirs` IPC / FS Access `fsAccessChildren` / 回退 `fallbackChildren` 反推）。ThumbnailGrid 对 `currentPath` 同样懒加载一层子目录（文件夹卡片数据源）。
3. `getVisibleImages`（视野 = currentPath + recursive，`scopeOk` 支持根内相对与祖先绝对路径）→ ThumbnailGrid（**文件夹条目在前 + 图片**，图标四档/列表，IntersectionObserver 懒加载 `<img src=getUrl()>`）/ Filmstrip；`getNavList` 供 ←/→ 与对比导航（**仅图片，不含文件夹**）。
4. `enterSingle / startCompareFromChecked / setViewMode` → `preloadCurrentContext` 预解码 → ViewerPane 帧交换上屏（命中当帧、未中保旧帧）。
5. 文件操作（右键）→ file-ops（IPC 或句柄）→ `rescan()` 刷新。
6. App 层：`navIds` 变化 → `reconcileNav(prevIds)` 把掉出集合的 currentId/slotA/slotB 夹回集合内最近项。

---

## 5. 构建与发布

**本地**：
```bash
npm install
npm run dev             # 网页版 dev（Vite，7100）
npm run electron:dev    # 桌面版 dev（Vite + Electron 并行）
npm run build           # tsc -b && vite build → dist/
npm run electron:build  # 本地打包（release/ 下 NSIS / DMG）
```

**CI（`.github/workflows/build-release.yml`）**：
- 触发：`push` 到 `main`、`push` 打 `v*` tag、`workflow_dispatch`（同一 workflow 两种发布路径）；
- `verify`（ubuntu-latest，Node 20）：`npm ci` → `npx tsc -p tsconfig.app.json --noEmit` → `npm run build`，失败阻断发布；
- `release`（needs: verify，矩阵 `windows-latest` / `macos-latest`）：构建后用 `npx electron-builder --win --x64 --publish never`（NSIS）/ `--mac --arm64 --publish never`（DMG，ad-hoc 签名）；
- **nightly 路径**（`github.ref_type == 'branch'`）：`softprops/action-gh-release@v2` 固定 `tag_name: nightly` 滚动预发布，资产固定名（`TwinView-Setup-windows-x64.exe` / `TwinView-macos-arm64.dmg`）→ 每次 push **同名覆盖**不刷屏；commit SHA 写入 release 正文追溯；
- **tag 正式发布路径**（`refs/tags/v*`）：资产名带版本号（`TwinView-Setup-<ver>-windows-x64.exe` / `TwinView-<ver>-macos-arm64.dmg`，`<ver>` = tag 去 `v` 前缀），`prerelease: false`，release 名 `TwinView <tag>`；正文由 awk 从 `CHANGELOG.md` 提取 `## [<ver>]` 段落生成（提取为空回退要点文案）+ 追加 Windows SmartScreen / macOS ad-hoc 安装说明。发版步骤：改 `package.json` version + 写 CHANGELOG → `chore(release): vX.Y.Z` commit → `git tag -a vX.Y.Z` → `git push origin main --follow-tags`；
- 本地无 `gh` CLI 时，用公开 REST API 盯 CI：`GET /repos/congyong/TwinViewer/actions/runs?event=push&branch=vX.Y.Z` 轮询三 job（verify + 2×release），全绿后 `GET /repos/congyong/TwinViewer/releases/tags/vX.Y.Z` 确认资产；badge 见 README。

---

## 6. 已知限制与技术债、排错指引

**已知限制**（同 README，不重复展开）：macOS 为 **ad-hoc 签名**（electron-builder 回退 `codesign -s -`，首次打开「右键 → 打开」，仍报损坏则 `xattr -dr com.apple.quarantine /Applications/TwinView.app`）、Windows **未签名**（SmartScreen 首次警示）；浏览器回退模式只读（含拖放）；FS Access 删除不可恢复；软件重采样为 CPU 卷积（大图停手后才出精确图）；网格 ≤9 张；数万张无虚拟滚动；旋转不写回文件。

**技术债**：
- `template-info.md` 为脚手架模板遗留，可删；
- 缩略图 / 胶片条 / 列表小图 `<img>` 直读 `entry.getUrl()`，不经 decode-cache（小图可接受）；
- 列表模式 `dimsCache`（像素尺寸）为无上限模块级 Map（仅存 w/h 数值，会话内增长可忽略）；
- `folderEntries` 为 O(图片数 × 本层子文件夹数) 的前缀归属遍历，单目录子文件夹极多（数百）时需优化；
- `copyNameOf` 在主进程与 `file-ops.ts` 双份实现，改动需同步；
- ViewerPane 的 effect 依赖 `layerKey` 字符串（配合 eslint-disable 注释），改 layers 语义时注意；
- 冒烟 `capturePage` 偶发 `UnknownVizError`（已内置 3 次重试）；
- `read-file-buffer` 单文件 >512MB 抛错（主进程硬限制）。

**排错指引**：
- 解码缓存行为：`localStorage.twinview.debugCache='1'` → console 看 命中/未命中/入缓存/淘汰/预算；
- 冒烟自检：`npm run build && TWINVIEW_SMOKE=1 NODE_ENV=production ./node_modules/electron/dist/electron.exe .`（断言点：10 图扫描、list-dirs、path-ancestors、read-file-buffer 像素非零、文件操作三件套、打开对话框 IPC（special-dirs/browse-dir/dir-image-preview 递归 count=10+4 张 + shallow 本层 count=8/dirs 含 sub/缩略图无子目录）、**UI 自动化：openPath 后断言递归关 8 张 ↔ 开 10 张、子文件夹卡片 `[data-folder]`、面包屑 `nav`、列表模式行数、`setCurrentPath('sub')` 面包屑段数与 `navigateUp()` 回根、主题亮/暗 class 切换、打开文件夹对话框渲染（含 sub 子目录按钮）**、**CLI 注入（send cli-open：folder+file 定位选中 sub 内文件；--compare 断言 viewMode/slotA/slotB/layout/theme/recursive flag）**、**真全屏布局（physicalFullscreen 状态级模拟：`[data-chrome]`/aside 全隐藏 → 恢复）+ 槽位导航（仅勾选占满时回退同图+无 notice、全部档步进跳过另一槽、激活侧切换步进、swap 回归、网格跳过占据格+网格回退同图）+ 视图级物理全屏 a.9（Shift+F 直进：对比 2 pane / 网格 4 pane 布局不变 + `[data-minibar]` + chrome 全卸载，退出恢复）+ 双击三层链 a.10（事件级 dblclick 进 L1 单格全屏；action 触发物理请求 + 状态级模拟 L2；L3 对比 A↔B 槽位内容不变、网格 '0'→'1'→'2' 格组不变；退出 chrome 恢复）+ 树点击回浏览 a.11（对比下模拟树节点点击 → browse + currentPath 正确；浏览中不变；Esc 回归）+ 差值热图 a.12（面板仅 diff 可见+滑块联动、canvas 挂载、同图全黑、异图非黑、单元级合成位图验容差、四种 colormap 齐全有序可切换、coolwarm 中点近白、gray 消色差）+ 录制状态机 a.13（S→配置对话框（GIF/低画质+持久化断言）→确认进倒计时→采集→**S 立即停止（无 stopping）**→saving 自动保存（冒烟模拟取消）→参数一致→放弃回 idle；GIF 单元 gif-core 档位/编码合法，采集成败仅报告）**、`<img>` 协议探测；输出 `[SMOKE]`，失败 `[SMOKE-FAIL]` 退出码 1）；
- `twinview://` 在 file:// 页面 fetch 失败是**预期**（Chromium 限制）；分析层必须走 `read-file-buffer` → blob，否则 canvas 被污染（`getImageData` 抛 SecurityError）；
- 黑闪/闪屏类问题：先看 ViewerPane 帧模型（stale 判定、finish 时机、pin 平衡），再看 CanvasSmooth 防抖分流。

---

## 7. 修改规约（重要）

1. **每轮功能改动完成后必须 `git commit`（规范 message）+ `git push` 到 `main`**；CI 会自动验证并滚动发布 nightly。
2. **改核心文件前先读磁盘真实代码**（`appStore.ts` / `ViewerPane.tsx` / `decode-cache.ts` / `fs-provider.ts` / `electron/main.cjs`），不要凭印象或二手笔记重写——本项目曾发生交接笔记与真实架构严重不符导致文件被误覆盖的事故（后从 dist 产物逆向救回）。大改前先确认当前行为再动刀。
3. TS 严格模式：`noUnusedLocals` / `verbatimModuleSyntax`（类型导入用 `import type`）；同一文件的多个 Edit 不要放在同一批工具调用里。
4. 新增 UI 文案保持中文；快捷键改动需同步 `HelpOverlay.tsx` 表格与 README 快捷键表。
5. 改 IPC 需三处同步：`electron/main.cjs`（实现）、`electron/preload.cjs`（桥接）、`src/lib/fs-provider.ts`（TwinviewBridge 类型），并更新本文 IPC 表与冒烟断言（如适用）。
6. 新增/调整偏好一律走 `settings.ts`（`SettingsData` + `DEFAULT_SETTINGS` + `sanitize` 校验三处同步），禁止新增散落 localStorage key；新增 UI 颜色一律用 `--tv-*` 变量（黑浮层族除外，见 §2.7）。
7. Kimi Work skill `twinview` 有两处副本：注册位置 `daimon-share/daimon/skills/twinview/SKILL.md` 与仓库副本 `skills/twinview/SKILL.md`——**改动必须两边同步**（仓库副本为准，改完拷贝覆盖注册位置）。
