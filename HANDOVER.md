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
| `select-directory` | — | `string \| null` | 系统目录选择框；取消返回 null |
| `scan-directory` | `(dir: string, recursive: boolean)` | `{path,name,size,lastModified}[]` | 递归收集图片（扩展名白名单 11 种）；无权限项跳过 |
| `list-dirs` | `(dir: string)` | `{name,path,imageCount,hasSubdirs}[]` | 一层子目录（文件夹树懒加载；imageCount 为本层直接图片数） |
| `path-ancestors` | `(dir: string)` | 同上（root-first，不含自身） | 祖先链，最多 64 级；`hasSubdirs` 恒 true |
| `read-file-buffer` | `(filePath: string)` | `Uint8Array \| null` | 渲染端转 blob 解码（分析层）；**>512MB 抛错** |
| `copy-files` | `(sources: string[], targetDir: string)` | `{ok: string[], failed: {name,error}[]}` | 重名自动 `- 副本` / `- 副本 (n)` |
| `make-dir` | `(parent: string, name: string)` | `{ok: boolean, error?: string}` | 非法字符 `\/:*?"<>\|` 与重名校验 |
| `trash-items` | `(paths: string[])` | `{ok, failed}` | `shell.trashItem` 进回收站 |

另暴露 `platform`、`versions`。`twinview://local/<encodeURIComponent(绝对路径)>` 由主进程 `net.fetch(pathToFileURL(...))` 提供，**仅供 `<img>` 显示**；Chromium 在 `file://` 页面禁止 fetch 自定义协议（冒烟中 fetchProbe 失败是**预期行为**），分析层一律走 `read-file-buffer` → blob。

---

## 2. 核心机制详解

### 2.1 fs-provider 双实现与探测（`src/lib/fs-provider.ts`）

- 运行时探测：`window.twinview` 存在 → `ElectronFSProvider`，否则 `BrowserFSProvider`（`getFSProvider()` 单例缓存）。
- 统一抽象 `ImageEntry`：`{id, name, path, size, lastModified, handle?, getUrl(), revoke()}`。
  - Electron：`id = 绝对路径`，`getUrl()` 返回 `twinview://` URL，`revoke()` 空操作；
  - 浏览器：`id = path::size::lastModified`，`getUrl()` 惰性创建 blob: URL，`revoke()` 释放。
- `DirectorySource`：`{name, handle?（FS Access）, files?（webkitdirectory 回退）, dirPath?（Electron）}`，三种形态决定目录树与文件操作的实现分支。
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
- **CanvasSmooth（双线性/双立方路径）防抖分流**：**图像源（bitmap/img）变化立即绘制**（useLayoutEffect，pre-paint）；仅尺寸/质量变化（连续缩放）才 120ms 防抖。canvas backing store 上限 4096px。
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
- 操作成功后 `rescan()`（重扫保留偏好，勾选/槽位/视图重置——见 freshState）。

### 2.5 浏览网格：子文件夹 / 面包屑 / 显示模式（`src/components/ThumbnailGrid.tsx`）

- **子文件夹条目**：当前目录的直接子文件夹（`treeChildren[currentPath]`，复用文件夹树的 `loadTreeChildren` 懒加载缓存，三种数据源行为一致）**无论 recursive 开关都显示，排在图片前**。
  - 图标档 = `FolderCard`：递归视野内前 4 张图片（按名称序）2×2 `object-cover` 拼贴（1 张占满整格），无图片时纯文件夹图标；名称 + 递归图片计数；IntersectionObserver 进入视口才 `getUrl()`。
  - 列表档 = `FolderRow`：文件夹图标 + 名称 + 「文件夹 · N」（计数列），像素尺寸/时间为 `—`；无勾选框（勾选是图片概念，勾选框只在图片行首）。
  - 交互：单击选中（组件本地 `selectedFolder`，切换目录自动清空）；**双击 = `setCurrentPath(node.relPath)` 进入**（与文件夹树同一视野机制）；右键仅「打开」（文件操作留后续）。
  - `folderEntries`：一次遍历 `images` 按 `scopeOk(e, dir, node.relPath, true)` 归入各子文件夹（同层不重叠，命中即停），供拼贴与计数；O(图片数 × 本层子文件夹数)。
- **面包屑**（`BreadcrumbBar`，网格上方固定条）：根名/逐段可点击跳转；`currentPath` 为祖先链绝对路径时分段为绝对前缀。左侧 ↑ 按钮 = `navigateUp()`（相对路径逐段回退到 `''`；绝对路径用 `absDirOf` 逐级向上）；**Backspace 同效**（useKeyboard 浏览分支）。文件夹树高亮、面包屑、网格视野共用 `currentPath`，天然一致。
- **显示模式四档**（`browseMode: 'large'|'medium'|'small'|'list'`，localStorage `twinview.browseMode` 持久化）：工具栏 segmented 替代原尺寸滑块；`BROWSE_MODE_SIZE` 固定映射 大 256 / 中 168 / 小 112（`setBrowseMode` 同步写 `thumbSize`；列表档不动 `thumbSize`，切回图标档尺寸不丢）。
- **列表模式**：`ListHeader` 列头（名称/大小/修改时间可点击——同列切 `sortAsc`、异列换 `sortKey`，复用全局排序状态）+ `ImageRow`（checkbox、40px 缩略图、名称、像素尺寸、大小、修改时间）/ `FolderRow`。
  - **像素尺寸**：`<img onLoad>` 读 `naturalWidth/Height`，模块级 `dimsCache`（Map，无上限，会话内有效）避免滚动闪烁；**不经 decode-cache**（小图直读 `getUrl()`，与缩略图同策略）。
  - 图片行双击进单图、单击 `setCurrent`（isCurrent 行 `scrollIntoView` 与胶片条联动）、右键同图标档文件操作菜单；勾选行底色 `bg-sky-600/15`。

---

## 3. 状态管理（`src/store/appStore.ts`，zustand 单一 store）

**state 分组**：
- 目录与列表：`providerKind, dir, loading, loadError, images, recursive, currentPath, treeChildren, treeExpanded, ancestors`
- 视野与排序：`formatFilter, sortKey, sortAsc, thumbSize, browseMode`；勾选/剪贴板：`checked, clipboard`
- 视图：`viewMode('browse'|'single'|'compare'|'grid'), currentId, fullscreenCell, physicalFullscreen`
- A/B：`slotA, slotB, activeSlot, compareLayout, sync, splitRatio, wipeRatio, overlayOpacity, overlaySwapped, transformA, transformB, sharedTransform`
- 网格：`gridIds, gridActiveIdx, gridSync, gridLayout, gridTransforms`；单图：`singleTransform`
- 开关：`navScope, resample, infoVisible, histoVisible, sidebarOpen, filmstripOpen, helpOpen`
- 收藏/取样：`favorites({path,addedAt}[]), samples(SampleRecord[]，≤10 条，seq 自增)`

**Action 分组**：打开/扫描（`openDirectory/openPath/rescan/loadTreeChildren/loadAncestors/toggleTreeNode`）；视野（`setRecursive/setCurrentPath/navigateUp/setFormatFilter/setSortKey/toggleSortAsc/setThumbSize/setBrowseMode`）；勾选（`toggleChecked/checkAll/clearChecked/setClipboard`）；导航（`setViewMode/setCurrent/enterSingle/navigate/reconcileNav`）；A/B（`startCompareFromChecked/ensureSlots/setSlot/assignCurrentToSlot/swapSlots/toggleActiveSlot/nextPair/setCompareLayout/cycleCompareLayout/setSync/setSplitRatio/setWipeRatio/setOverlayOpacity/toggleOverlaySwapped`）；网格（`setGridLayout/setGridSync/setGridActiveIdx/setGridCellImage/setGridTransform/nextBatch`）；变换（`setSingleTransform/setSharedTransform/setTransformA/setTransformB/rotateCurrent/resetView`）；偏好（`setNavScope/setResample/toggleInfo/toggleHisto/toggleSidebar/toggleFilmstrip/toggleHelp`）；全屏/取样（`setFullscreenCell/togglePhysicalFullscreen/addSample/clearSamples`）；收藏（`addFavorite/removeFavorite`）；清理（`revokeAll`）。

**导出辅助**：`newTransform()`、`getVisibleImages(q)`（scopeOk + 格式过滤 + 排序）、`getNavList(q)`（再按 navScope==='checked' 过滤）、`preloadCurrentContext(s)`（内部：按当前视图预解码——compare=[A,B]、grid=全部格、single=当前±1）、`BROWSE_MODE_SIZE`（图标三档固定尺寸映射）。

**持久化键**（localStorage）：`twinview.favorites / .splitRatio / .wipeRatio / .resample / .navScope / .compareLayout / .histoVisible / .browseMode / .debugCache`（调试开关）。`freshState(dir, images)` 在打开/重扫时重置浏览状态但**保留全部偏好**。dev 构建下 store 暴露为 `window.__twinviewStore`（冒烟 UI 自动化与控制台调试；生产构建由 Rollup 消除）。

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
- 触发：`push` 到 `main` + `workflow_dispatch`；
- `verify`（ubuntu-latest，Node 20）：`npm ci` → `npx tsc -p tsconfig.app.json --noEmit` → `npm run build`，失败阻断发布；
- `release`（needs: verify，矩阵 `windows-latest` / `macos-latest`）：构建后用 `npx electron-builder --win --x64 --publish never`（NSIS）/ `--mac --arm64 --publish never`（DMG，`mac.identity=null` 免签名）；
- 发布：`softprops/action-gh-release@v2` 固定 `tag_name: nightly` 滚动预发布，资产固定名（`TwinView-Setup-windows-x64.exe` / `TwinView-macos-arm64.dmg`）→ 每次 push **同名覆盖**不刷屏；commit SHA 写入 release 正文追溯。
- 本地无 `gh` CLI 时，到仓库 Actions 页确认运行；badge 见 README。

---

## 6. 已知限制与技术债、排错指引

**已知限制**（同 README，不重复展开）：macOS/Windows 均**未签名**（Gatekeeper / SmartScreen 首次警示）；浏览器回退模式只读；FS Access 删除不可恢复；双线性/双立方为 Canvas 近似；网格 ≤9 张；数万张无虚拟滚动；旋转不写回文件。

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
- 冒烟自检：`npm run build && TWINVIEW_SMOKE=1 NODE_ENV=production ./node_modules/electron/dist/electron.exe .`（断言点：10 图扫描、list-dirs、path-ancestors、read-file-buffer 像素非零、文件操作三件套、**UI 自动化：openPath 打开测试目录后断言子文件夹卡片 `[data-folder]`、面包屑 `nav`、列表模式行数、`setCurrentPath('sub')` 后面包屑段数与 `navigateUp()` 回根**、`<img>` 协议探测；输出 `[SMOKE]`，失败 `[SMOKE-FAIL]` 退出码 1）；
- `twinview://` 在 file:// 页面 fetch 失败是**预期**（Chromium 限制）；分析层必须走 `read-file-buffer` → blob，否则 canvas 被污染（`getImageData` 抛 SecurityError）；
- 黑闪/闪屏类问题：先看 ViewerPane 帧模型（stale 判定、finish 时机、pin 平衡），再看 CanvasSmooth 防抖分流。

---

## 7. 修改规约（重要）

1. **每轮功能改动完成后必须 `git commit`（规范 message）+ `git push` 到 `main`**；CI 会自动验证并滚动发布 nightly。
2. **改核心文件前先读磁盘真实代码**（`appStore.ts` / `ViewerPane.tsx` / `decode-cache.ts` / `fs-provider.ts` / `electron/main.cjs`），不要凭印象或二手笔记重写——本项目曾发生交接笔记与真实架构严重不符导致文件被误覆盖的事故（后从 dist 产物逆向救回）。大改前先确认当前行为再动刀。
3. TS 严格模式：`noUnusedLocals` / `verbatimModuleSyntax`（类型导入用 `import type`）；同一文件的多个 Edit 不要放在同一批工具调用里。
4. 新增 UI 文案保持中文；快捷键改动需同步 `HelpOverlay.tsx` 表格与 README 快捷键表。
5. 改 IPC 需三处同步：`electron/main.cjs`（实现）、`electron/preload.cjs`（桥接）、`src/lib/fs-provider.ts`（TwinviewBridge 类型），并更新本文 IPC 表与冒烟断言（如适用）。
