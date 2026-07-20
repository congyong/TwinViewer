# TwinView 图片对比浏览器

跨平台（Windows / macOS）桌面图片浏览器，风格类似 XnView / FastStone，核心亮点为 **A/B 双图对比** 与 **多图网格对比**。同一套 React 代码既可作为网页版完整运行，也可通过 Electron 桌面壳使用原生文件系统。

- 界面语言：中文
- 主题：FastStone 风格深色主题
- 技术栈：React 19 + TypeScript + Vite + Tailwind + shadcn/ui + zustand；Electron 桌面壳（CommonJS 主进程 + contextBridge preload）

---

## 功能清单

### 布局
- 顶部工具栏、左侧**文件夹树**/收藏/取样记录栏（可折叠）、中间主区、底部缩略图胶片条（可折叠）
- 四个主视图状态：**浏览**（缩略图网格）/ **单图** / **A/B 对比** / **多图网格对比**
- 工具栏模式切换只有「浏览 / 单图」两档：**A/B 对比不设专门的模式按钮**，由勾选 2 张后点「对比选中」或 A/B 键进入；勾选 ≥ 3 张点「对比选中」进入多图网格

### 文件夹树（侧栏）
- 打开文件夹后以所开文件夹为根显示目录树（只列目录），节点可折叠/展开，显示目录名与图片数（Electron / FS Access 模式为**本层直接图片数**，webkitdirectory 回退模式为**含子目录递归数**，悬浮计数徽标有说明）
- 子层**懒加载**：展开时才枚举下一层（Electron 走 `list-dirs` IPC；FS Access 用目录 handle 枚举；回退模式从图片相对路径反推）
- **祖先链（Electron）**：树根上方显示打开根的全部上级目录（盘符 → … → 父目录），逐级缩进、默认折叠；点击祖先节点即把「当前目录」切换到根之外的祖先目录（视野过滤支持绝对路径）；展开祖先节点可继续向下浏览（祖先链中指向打开根本身的节点自动映射回树根）。浏览器模式无权限访问上级目录，树顶部显示提示
- 点击节点 = 切换「当前目录」：网格与胶片条同步只显示该目录（配合「含子文件夹」开关决定只看本层还是含子树），当前节点高亮；空目录同样显示（回退模式除外）

### 浏览模式
- 「打开文件夹」（Electron 用系统对话框；浏览器用 File System Access API，Firefox/Safari 自动回退 `webkitdirectory`）；扫描始终递归，「含子文件夹」为视野开关
- 图片格式过滤下拉（jpg/jpeg/png/gif/webp/bmp/avif/svg/ico/tif/tiff）
- 缩略图网格：IntersectionObserver 懒加载、显示文件名、尺寸滑块（96–320px）
- 排序：名称 / 修改时间 / 大小，升/降序切换
- **勾选标记仅保留左上角 checkbox**（选中态由边框高亮表达，不再显示右上角角标）
- 单击选中（琥珀色高亮），双击进入单图模式；**右键缩略图 = 文件操作菜单**（见下节）
- **胶片条常驻**，内容 = 当前目录视野内图片，与网格同步；浏览模式单击 = 选中并滚动定位（网格同步高亮），双击进入单图
- 胶片条「导航范围：全部 / 仅勾选」切换，**无历史设置时默认「仅勾选」**（选择会持久化，老用户保留上次选择）；选「仅勾选」时胶片条与 ←/→ 导航只在勾选项中循环

### 文件操作（浏览模式右键菜单，自绘轻量菜单）
- **右键缩略图**：复制 / 粘贴 / 新建文件夹 / 删除。右键项在勾选集合内时，操作对象为**视野内全部勾选项**，否则仅右键项
- **右键网格空白处**：粘贴 / 新建文件夹 / 刷新
- **复制**：存入应用内剪贴板（图片列表）；**粘贴**：把剪贴板中的文件复制到**当前目录**，重名自动命名为「`name - 副本.ext`」「`name - 副本 (2).ext`」…
- **新建文件夹**：弹输入框命名（非法字符与重名给出错误提示）
- **删除**：确认对话框逐条列出待删文件——**Electron 走 `shell.trashItem` 移入回收站**（可恢复）；**浏览器 FS Access 用 `handle.remove()` 直删，不进回收站、不可恢复**（确认文案明确警示，需 Chrome 110+）
- 浏览器 FS Access 模式在打开文件夹时请求 `readwrite` 权限，操作前再次按需申请；**webkitdirectory 回退模式不支持写操作**（菜单项禁用并注明原因）
- 操作成功后自动刷新目录列表与文件夹树计数；失败的单个文件逐条列出错误（toast 摘要，最多列 3 条）
- Electron 通过新增 IPC 实现：`copy-files`（主进程侧重名检测+副本命名）/ `make-dir` / `trash-items`

### 单图模式
- 适应窗口 / 实际大小（100%）切换；滚轮以鼠标为中心缩放；拖拽平移；双击在适应 ↔ 100% 间切换
- ← / → 或 PgUp / PgDn 切换上一张 / 下一张（**当前张 ±1 自动预取解码**）；R / L 键旋转 90°（仅视图层，不修改文件）
- **F = 应用内单图全屏**：铺满主区并隐藏侧栏与胶片条（保留工具栏），顶部迷你条显示文件名；Esc / F / 双击退出；适应窗口改用工具栏「适应」按钮
- **信息浮层 / 直方图**（见下文）
- 状态栏：文件名、像素尺寸、文件大小、当前缩放比例、序号 (i/N)

### A/B 对比模式
进入方式（无独立模式按钮）：

- **a) FastStone 方式**：浏览模式勾选恰好 2 张 → 工具栏「对比选中」可用；先勾选者进 A 槽（左），后者进 B 槽（右）
- **b) XnView 方式**：浏览/单图模式按 A / B 键把当前图放入对应槽位（单图模式下两槽齐备后自动进入对比）；对比模式下底部胶片条点击即切换当前激活侧的图片；Tab 键切换激活侧
- **c) 勾选集导航**：胶片条每项带勾选框；「导航范围」默认仅勾选；勾选变化实时生效，当前图掉出集合时自动跳到集合内最近项

对比视图（三种布局，**W 键循环切换**（G 为别名），**无历史设置时默认「并排」**，选择持久化）：
- **并排（新默认）**：左右双窗格，槽位标签 A（蓝）/ B（橙）与文件名；中间可拖拽分隔条（比例持久化）；激活侧高亮边框；**同步开关（默认开）**：两侧共享缩放与平移，关闭后各自独立
- **划变（wipe）**：A、B 渲染在**同一视图区域**、几何完全对齐（共享缩放/平移，尺寸不同按各自图宽 × 相同比例）；竖直分割线在图片中间，**左侧显示 A、右侧显示 B**（B 叠于上层用 clip-path 裁掉左侧）；分割线带抓握手柄可左右拖拽（手柄优先于拖图平移），位置持久化到 localStorage；左上角 A 标签、右上角 B 标签
- **叠化（onion-skin）**：B 叠在 A 上，透明度滑块控制上层不透明度，可一键交换上下层
- 三种布局均支持：滚轮缩放、拖拽平移、Tab 切激活侧、A/B 键选定激活侧、X 交换 A/B、N 下一对（仅勾选导航且勾选 ≥4 张）、仅勾选导航
- **单格全屏**：双击图片或按 F 把激活槽那张图铺满整个对比区域（沿用该格缩放/平移），顶部迷你条显示槽位与文件名；Esc / F / 双击退出
- **信息浮层 / 直方图**：并排布局两格各一份；划变/叠化布局显示激活槽那份
- Esc 返回浏览模式，**保留勾选状态**

### 多图网格对比（勾选 ≥ 3 张）
- 浏览模式勾选 ≥ 3 张点「对比选中」进入，最多取前 **9 张**（进入时的勾选快照）
- **自动布局**（默认）：候选 1×2 / 2×1 / 1×3 / 3×1 / 2×2 / 2×3 / 3×2 / 3×3 中，取能容纳 N 张的最小格子数，并列时行列比最接近容器宽高比；窗口尺寸变化实时重排
- **手动布局**：工具栏下拉选 1×2 / 2×1 / 2×2 / 3×2 / 2×3 / 3×3；格子数少于图片数时只显示前若干张
- **同步 / 独立两档**：同步（默认）所有格子共享缩放平移（zoom 为各自图宽的比例，天然对齐）；独立每格各自调整
- **激活格**：点击任意格激活（高亮边框 + 序号徽标变蓝），Tab 或数字键 1–9 直接切换；← / → 更换激活格的图片
- **胶片条点击 = 替换激活格图片**（若该图已在其他格，两格交换避免重复）
- **N 键 / 「下一组」按钮**：在勾选池（或全部导航集）中整批推进下一组
- **单格全屏**：双击或 F 全屏激活格（Esc / F / 双击退出）
- 工具栏「适应 / 1:1 / 旋转」对网格同样生效（同步档作用于共享变换，独立档作用于全部格子）

### 全屏双模式（控件内全屏 + 物理全屏）
- **控件内全屏（默认）**：单图 / 对比 / 网格的单格全屏均为应用内实现（铺满主区，不离开窗口）；单图全屏额外隐藏侧栏与胶片条
- **物理全屏（Fullscreen API）**：任意单格全屏中，顶部迷你条提供「物理全屏」按钮（快捷键 **Shift+F**），隐藏浏览器 / 系统窗口边框；状态以 `fullscreenchange` 事件为准（F11 等外部途径进出同样同步）
- **Esc 逐级退出**：先退物理全屏 → 再退控件内单格全屏 → 最后返回浏览模式

### ALT 颜色探针与取样记录
- **按住 ALT**：鼠标变 crosshair，指针旁浮签实时显示**原图坐标 (x, y)** 与 **RGB(A) 色值 + 色块**（坐标经当前 transform 逆映射换算，含旋转；指针移出图片区域浮签自动隐藏）
- **ALT+单击**：把该点记入侧栏底部可折叠的「**取样记录**」区（序号 : 槽位 : 文件名 : (x,y) : RGB + 色块，最多 10 条，附清空按钮）；该点击被拦截，不会触发平移 / 激活切换 / 双击语义
- **探针图层选择**：划变 / 叠化取激活槽对应的图层，并排 / 网格 / 单图取本格图片；槽位标签分别为 A / B、格序号、单图为「—」
- **像素来源**：分析层离屏 canvas（与会话解码缓存同一份 blob 解码 bitmap，canvas 不被 twinview:// 污染）；每张图一次性绘制（最长边 ≤4096 限制内存，取样坐标按比例换算），canvas 按 entry 缓存（LRU 上限 4 张）；探针本身**不触发新的文件解码**（仅复用显示层已解码的 bitmap）
- 随会话边界（打开 / 重扫文件夹、退出对比到浏览）一并清空

### 会话解码缓存（`src/lib/decode-cache.ts`）
- key = 图片 id，value = `{ bitmap, url, natural, bytes }`：**优先 `createImageBitmap`**（失败回退 HTMLImageElement + blob URL）
- **字节预算 LRU**：每张解码图按 `宽 × 高 × 4`（RGBA）计字节，**总预算 1GB**；插入新图超预算时按最久未用淘汰（`bitmap.close()` + revoke blob URL），超大图与超大文件夹均内存安全
- **pin 保护**：正在显示的图层由 ViewerPane 通过 `pinDecoded()` 加保护计数，**在显图不可被淘汰**；极端情况（全部 pinned）允许暂时超预算，绝不淘汰在显图，unpin 后补淘汰
- **预取策略（并发 ≤3）**：进入对比（A/B 或网格）时预解码整个选中集合；对比会话内换槽 / 下一对 / 下一组 / 胶片条点选 / ←→ 导航都命中缓存，**零重解码**；单图模式预取当前张 ±1
- **切换缩放算法零解码**：bitmap 只与 entry.id 关联，重采样算法仅影响「bitmap → 屏幕」的绘制（Canvas 平滑参数或 CSS `image-rendering`），**不触碰缓存**；调试验证：`localStorage` 设 `twinview.debugCache=1` 后切算法，console 无「未命中」日志
- **双缓冲无缝切图**：新图就绪前 ViewerPane 保留旧帧（不清空、不卸载旧图层），缓存命中经 `peekDecoded` 同步取帧（layout effect 内当帧渲染，无 await 间隙）；Canvas 重采样在图像源变化时立即绘制（跳过防抖），黑背景仅在真正无图时出现
- **调试日志**：`twinview.debugCache=1` 时输出命中 / 未命中 / 入缓存（含 MB 占用）/ 淘汰 / 清空
- **清空时机**：退出对比/网格返回浏览、打开/重扫文件夹时全量释放（在途解码结果落地即弃，不回填缓存）
- 渲染层：canvas 重采样直接 `drawImage(bitmap)`；普通 `<img>` 模式用缓存的 blob URL，**natural 尺寸从缓存读取**（切换不闪烁）；缩放同步几何逻辑不受影响
- Electron 下字节经 `read-file-buffer` IPC 读取后 `new Blob([buffer])` 解码——blob 同源，**canvas 不污染**（直方图/EXIF/探针分析层与 canvas 重采样同用此缓存）

### 缩放重采样算法（全局，工具栏右侧下拉）
- **自动**（默认）：浏览器默认平滑缩放；放大超过 400% 时自动切换为像素风（nearest）
- **邻近**：始终 `image-rendering: pixelated`，硬边缘无平滑
- **双线性\***：Canvas `drawImage` + `imageSmoothingQuality: 'low'` 重采样（近似）
- **双立方\***：Canvas `drawImage` + `imageSmoothingQuality: 'high'` 重采样（近似）
- \* 双线性 / 双立方为 **Canvas 平滑品质的近似实现**，并非逐像素卷积；连续缩放过程中 120ms 防抖重绘（停手后出清图；**切图换源时立即绘制，无黑帧**），Canvas backing store 上限 4096px；绘制源取自会话解码缓存的 ImageBitmap；选择持久化到 localStorage；**切换算法不触发重新解码**（见上节）

### 信息浮层与直方图（两个独立开关）
- **信息浮层（I 键 / 工具栏 i 按钮）**：文件名、像素尺寸、文件大小、当前缩放、序号 (i/N) + **EXIF**（exifr 解析：拍摄时间、相机、镜头、ISO、光圈、快门、焦距、GPS，按图片缓存）
- **直方图（工具栏柱状图按钮，状态持久化）**：**固定展开**（无折叠交互），220×100 canvas，亮度填充 + RGB 折线，**X 轴带值域刻度 0 / 64 / 128 / 192 / 255**（刻度线 + 数字标签）
- 两个都开时浮层里依次排布（基本信息 → 直方图 → EXIF）；多格视图（并排/网格）每格浮层显示对应图的直方图，抽样数据源走会话解码缓存（≤256px 抽样），不重复解码
- Electron 桌面版直方图/EXIF 经 `read-file-buffer` → blob 解码，**与浏览器版同样可用**（不再受 twinview:// 污染 canvas 限制）
- 浮层拦截指针事件，不误触发平移

### 通用
- 「?」快捷键帮助浮层（列出全部快捷键）
- object URL 内存管理：切换文件夹统一 revoke；组件卸载统一 revoke；解码缓存按 1GB 字节预算 LRU 管理
- 空态引导页（打开文件夹 + 用法说明）
- 状态管理：zustand + React hooks
- 代码结构：`src/components/`（Toolbar、Sidebar、ThumbnailGrid、Filmstrip、ViewerPane、CompareView、CompareGrid、SingleView、InfoOverlay、FileOpsMenu、FullscreenMiniBar、StatusBar、HelpOverlay、EmptyState）、`src/hooks/`（useKeyboard）、`src/lib/`（fs-provider、dir-tree、decode-cache、pixel-probe、image-info、file-ops、format）、`src/store/`（appStore）

---

## 快捷键表

| 按键 | 功能 |
| --- | --- |
| ← / → 或 PgUp / PgDn | 上一张 / 下一张（按当前导航范围循环；对比模式换激活侧，网格模式换激活格图片） |
| R / L | 向右 / 向左旋转 90°（仅视图层） |
| F | 单图 / 对比 / 网格 = 进入或退出对应单格全屏（控件内） |
| Shift+F | 单格全屏中切换物理全屏（隐藏浏览器 / 窗口边框） |
| Alt（按住） | 颜色探针：浮签显示原图坐标与 RGB；ALT+单击记录到侧栏取样列表 |
| 1 | 实际大小 100%（单图 / 对比）；网格中为激活第 1 格 |
| 1 – 9 | 网格模式：激活第 N 格 |
| 双击图片 | 单图：适应窗口 ↔ 100%；对比 / 网格：进入或退出单格全屏 |
| 滚轮 | 以鼠标为中心缩放 |
| 拖拽 | 平移图片 |
| I | 显示 / 隐藏信息浮层（基本 + EXIF；直方图由工具栏独立开关） |
| 空格 | 勾选 / 取消勾选当前图片 |
| A / B | 浏览 / 单图：把当前图片设为 A / B 槽；对比：选定激活侧 |
| Tab | 对比：切换激活侧（A ↔ B）；网格：循环激活格 |
| X | 交换 A/B |
| W / G | 循环对比布局（并排 → 叠化 → 划变） |
| N | 对比：下一对（仅勾选导航且勾选 ≥4 张）；网格：下一组 |
| Esc | 物理全屏 → 单格全屏 → 返回浏览模式（逐级，保留勾选） |
| ? | 打开 / 关闭快捷键帮助 |

> F 键语义统一为「进入 / 退出对应单格全屏」（单图此前为「适应窗口」，现适应窗口请用工具栏「适应」按钮）；网格中数字键优先作为格子选择，100% 缩放请用工具栏「1:1」按钮。直方图显隐无快捷键，由工具栏 toggle 控制。

---

## 网页版运行方式

```bash
npm install        # 首次
npm run dev        # 开发，默认 http://localhost:7100（支持 --host/--port CLI 参数覆盖）
npm run build      # 生产构建（tsc + vite build，输出 dist/）
npm run preview    # 预览生产构建
```

浏览器中打开 http://localhost:7100 即可完整使用全部功能。

## Electron 桌面版运行 / 打包

```bash
# 开发：同时启动 Vite dev server 与 Electron 窗口
npm run electron:dev

# 打包：先构建网页版，再用 electron-builder 产出安装包
npm run electron:build
```

- Windows 产出：`release/` 下的 **NSIS 安装包**（`win.target: nsis`）
- macOS 产出：`release/` 下的 **DMG**（`mac.target: dmg`，`category: public.app-category.photography`）
- 桌面版通过 preload 注入 `window.twinview`（contextIsolation 开启），渲染进程自动切换为 `ElectronFSProvider`；本地图片经自定义安全协议 `twinview://` 由主进程 `net.fetch(pathToFileURL(...))` 提供，免拷贝、不暴露 Node API

> 若 Electron 二进制因网络原因下载失败，可用镜像重试：
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`

### 冒烟测试（桌面版）

主进程内置冒烟测试模式：打开真实窗口后自动扫描 `../test-photos`（递归）并校验数量/格式/子目录，验证 `list-dirs` / `path-ancestors` / **`read-file-buffer`（含渲染端 blob → createImageBitmap → getImageData 非零断言）** / **文件操作三件套（make-dir → copy-files 含重名副本 → trash-items，临时目录内执行后清理）** 等 IPC，截取主界面保存为 `smoke-home.png`，检查渲染进程的 `window.twinview` 桥接与 UI 内容，并用 `<img>` 探测 `twinview://` 协议链路，全部结果打印 `[SMOKE]` 前缀日志后自动退出（失败打印 `[SMOKE-FAIL]` 并以退出码 1 结束）：

```bash
npm run build   # 冒烟模式加载 dist，需先构建
TWINVIEW_SMOKE=1 NODE_ENV=production ./node_modules/electron/dist/electron.exe . 2>&1 | tee smoke-output.txt
```

测试图片可用 `python ../test-photos/make_images.py` 重新生成（8 张 + sub/ 2 张）。正常模式（无 `TWINVIEW_SMOKE`）行为不受影响。

## 浏览器兼容性

| 浏览器 | 文件夹访问方式 | 文件操作 |
| --- | --- | --- |
| Chrome / Edge / Opera（Chromium 系） | File System Access API（`showDirectoryPicker`，readwrite） | 全部可用（删除为直删，不可恢复） |
| Firefox / Safari | 自动回退 `<input type="file" webkitdirectory>`（始终为递归选择） | 不支持写操作（菜单项禁用） |

- 所有文件仅在本机读取，绝不上传
- 桌面（Electron）版无浏览器限制，使用原生文件系统，性能最佳

## 架构说明

```
src/lib/fs-provider.ts     文件系统抽象层（FSProvider 接口）
  ├─ BrowserFSProvider     File System Access API（readwrite）/ webkitdirectory 回退
  └─ ElectronFSProvider    window.twinview IPC + twinview:// 协议
src/lib/decode-cache.ts    会话解码缓存（ImageBitmap 优先，1GB 字节预算 LRU + pin 保护，对比预取/退出清空）
src/lib/pixel-probe.ts     ALT 颜色探针像素读取（复用解码缓存 bitmap → 离屏 canvas，LRU 4 张）
src/lib/image-info.ts      直方图（解码缓存抽样）与 EXIF（blob + exifr），按图片缓存
src/lib/file-ops.ts        文件操作（粘贴/新建文件夹/删除；Electron IPC 与 FS Access 双实现）
electron/main.cjs          主进程：窗口、IPC（select-directory / scan-directory / list-dirs /
                           path-ancestors / read-file-buffer / copy-files / make-dir / trash-items）、
                           twinview:// 协议
electron/preload.cjs       contextBridge 暴露 window.twinview
```

运行时探测：存在 `window.twinview` 即用 Electron 实现，否则用浏览器实现，同一套 UI 代码零分支。

## 已知限制

- 浏览器模式无法访问所开文件夹的上级目录（浏览器安全模型限制），侧栏树顶部有提示；祖先链仅 Electron 可用
- 浏览器回退模式（Firefox/Safari）：文件夹选择始终为递归；文件夹树只能从含图片的路径反推（空目录无法显示）；**不支持任何写操作**（复制可用但粘贴/新建/删除禁用）
- **浏览器 FS Access 的删除为 `handle.remove()` 直删，不进回收站、不可恢复**（UI 确认文案有明确警示；需 Chrome 110+）；Electron 删除进回收站
- 超大文件夹（数万张）未做虚拟滚动，缩略图懒加载可正常使用但 DOM 节点较多；解码缓存按 1GB 字节预算 LRU 保护内存
- 网格对比最多 9 张（3×3）；手动布局格子数少于图片数时其余图需用「下一组」查看
- 双线性 / 双立方缩放为 Canvas `imageSmoothingQuality` 的**近似**，非逐像素卷积实现
- ALT 探针的离屏 canvas 每张最长边限制 4096px（超大图按比例换算取样，精度随缩放略降），canvas 缓存上限 4 张（合计内存 ≤ ~268MB）；twinview:// 兜底路径（无 blob）下探针取不到值（浮签显示「读取中…」，Electron 正常路径均为 blob 不受影响）
- Electron 生产模式（`file://` 页面）下 Chromium 禁止渲染进程 `fetch()` 自定义协议 URL：显示层 `<img src="twinview://…">` 不受影响；**分析层（直方图/EXIF/探针/canvas 重采样）一律改走 `read-file-buffer` → blob，已验证可用**（冒烟测试断言像素非零）
- 导航范围默认「仅勾选」、A/B 对比默认「并排」仅影响**无历史存储**的新用户；老用户保留 localStorage 中的上次选择
- 旋转仅为视图层效果，不写回文件
- AVIF / TIFF 等格式依赖浏览器自身解码能力（Chromium 支持 AVIF；TIFF/ICO 在部分浏览器可能无法显示）
