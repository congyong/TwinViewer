# TwinView 图片对比浏览器

[![build-release](https://github.com/congyong/TwinViewer/actions/workflows/build-release.yml/badge.svg)](https://github.com/congyong/TwinViewer/actions/workflows/build-release.yml)

跨平台（Windows / macOS）桌面图片浏览器，风格类似 XnView / FastStone，核心亮点为 **A/B 双图对比** 与 **多图网格对比**。同一套 React 代码既可作为网页版完整运行，也可通过 Electron 桌面壳使用原生文件系统。

- 界面语言：中文 ｜ 主题：FastStone 风格深色
- 技术栈：React 19 + TypeScript + Vite + Tailwind + shadcn/ui + zustand；Electron 桌面壳（CommonJS 主进程 + contextBridge preload）

**📦 正式版 v0.2.2（推荐）**：<https://github.com/congyong/TwinViewer/releases/latest>

- Windows：`TwinView-Setup-0.2.2-windows-x64.exe`（NSIS 安装包，可选安装目录；未签名，SmartScreen 首次提示选「仍要运行」）
- macOS：`TwinView-0.2.2-macos-arm64.dmg`（Apple Silicon，**ad-hoc 签名**（无开发者证书）：首次打开请「右键 → 打开」绕过 Gatekeeper；若仍提示「已损坏」，执行 `xattr -dr com.apple.quarantine /Applications/TwinView.app` 后再开）

**🌙 Nightly 下载（每次 main push 自动构建，滚动覆盖）**：<https://github.com/congyong/TwinViewer/releases/tag/nightly>

- Windows：`TwinView-Setup-windows-x64.exe`（NSIS 安装包，可选安装目录）
- macOS：`TwinView-macos-arm64.dmg`（Apple Silicon，签名与打开方式同正式版）

---

## 一指禅 · 30 秒上手

1. **对比三连**：选择文件夹 → 勾选两张图 → 点工具栏「对比选中」→ **双击**图片进该图控件全屏 → **再双击**进物理全屏 → **再双击**切换左右图源（X 键、←/→ 键同样可切）→ **Esc** 逐层回退
2. **全屏两键**：`F` = 当前图控件内最大显示（对比 = 激活格 / 网格 = 当前格，再按退出）；`Shift+F` = 当前视图整体物理全屏
3. **取色**：按住 `Alt` 鼠标取色，单击取样，记录在左列左下角取样列表
4. **求助**：`?` 打开完整快捷键列表

---

## 主要特性

| 模块 | 能力 |
| --- | --- |
| 浏览 | 缩略图网格（懒加载）+ **显示模式四档**（大 / 中 / 小图标、列表，持久化）；**子文件夹条目**（Windows 风文件夹图标 + 预览拼贴 + 计数，双击进入）排在图片前；**面包屑路径导航**（Backspace 返回上级）；含子文件夹开关（**默认关**，持久化）、格式过滤、名称/日期/大小排序（列表模式点列头）、全选 / 清除选择、勾选、右键文件操作（复制/粘贴/新建文件夹/删除）；**系统拖放**文件/文件夹递归复制到当前目录（带投放指示层） |
| 文件夹树 | 懒加载目录树、祖先链（Electron 可浏览上级目录）、收藏夹（持久化）、ALT 取样记录区 |
| 打开文件夹 | **选择即打开**（无二次确认）。Electron：自绘对话框（快捷入口 + 子目录**单击选中 / 双击进入** + 右侧**本层预览**：子文件夹条目（图标+名称，单击进入）与本层图片缩略图，计数按本层不递归；「打开此文件夹」直接生效；系统对话框 win32 下文件/文件夹均可选，选中文件 = 打开所在文件夹并定位）；浏览器：选择后直接打开 |
| 主题 | 暗色 / 亮色 / 跟随系统三档（工具栏切换，持久化；Electron 窗口背景同步，首帧防闪） |
| 单图 | 适应窗口 / 100%、滚轮锚点缩放、拖拽平移、R/L 旋转、F 控件全屏（隐藏侧栏与胶片条） |
| A/B 对比 | **划变**（同区域对齐 + 可拖分割线）/ **并排**（可拖比例 + 同步开关）/ **叠化**（透明度 onion-skin，可换上下层）/ **差值**（逐像素差值热图：三通道 max abs diff，≤容差置黑，其余默认**直方图均衡**——>容差的幅值按 CDF 累积分布重映射到全区间，两图很接近时小差异拉伸可见，面板可关回线性归一（默认开，持久化），并实时显示 diff 最大值；过 colormap——inferno / gray / viridis / coolwarm + 容差 0–128 可调并持久化；B 缩放到 A 尺寸对齐，缩放平移不重算，源图/容差/均衡变化才重算；D 键开关，再按 D 返回之前布局），W/G 循环前三种；Tab 切激活侧；X 交换；N 下一对 |
| 显示区录制 | 工具栏按钮 / `S` 键：先弹**开录前配置对话框**（格式 **MP4 / GIF** + 画质 高/中/低，默认取上次选择并持久化；GIF 格式另有**抓帧方式二选一**：连续采样 / **切换抓帧**（新用户默认切换抓帧），持久化记住）→「开始录制」→ 3 秒倒计时胶囊（可取消）→ 红点计时徽标录制 → **再按 S 立即停止** → 直接弹系统保存对话框选位置（格式/画质按开录前选择，不再询问）。Electron 采集本窗口并按显示区裁剪（desktopCapturer + 镜像 canvas，MediaRecorder 优先 MP4、不支持落 WebM 并明示；GIF = gifenc，**连续采样**：**高 15fps·≤1280 宽·256 色 rgb888 全局调色板 + Floyd–Steinberg 抖动**（末尾 20 秒），中 12fps·720 宽·192 色抖动（30 秒），低 8fps·480 宽·128 色（30 秒）；**切换抓帧**：当前显示图像变化（单图/对比槽位/网格/全屏格）才去抖抓一帧，**全分辨率不降采样**（显示区设备像素原尺寸，仅 >2560 宽封顶），**帧间时长固定可配**（配置对话框 0.1–5 秒，默认 0.5，持久化；编码时每帧 delay 统一用该值，含末帧——v15 起替代按真实时间戳间隔的策略），上限 60 帧，录制中可按 **C** 手动补帧、徽标实时显示已抓帧数）；上限 10 分钟自动停；视图切换自动停止释放 |
| 多图网格 | 勾选 ≥3 张进入（最多 9 张）；自动/手动布局；同步/独立两档；数字键选格；N 下一组 |
| 解码缓存 | 会话级字节预算 LRU（**1GB**，按 宽×高×4 计）、在显 pin 保护、预取（对比集合 / 单图 ±1）、**双缓冲无缝切图**、调试日志（`twinview.debugCache=1`） |
| 缩放算法 | 自动 / 邻近 / **BIFant\* / 双线性\* / 双立方\* / Lanczos-3\***（\*为软件精确重采样：浏览时平滑预览，停手 ~150ms 后 CPU 可分离卷积精确重绘，LRU 缓存 8 张；**切算法零解码**） |
| ALT 颜色探针 | 按住 ALT 显示原图坐标 + RGB(A) 浮签（经 transform 逆映射，含旋转）；ALT+单击记入侧栏取样列表（≤10 条） |
| 信息浮层 | 基本信息 + EXIF（exifr，按图缓存）；独立开关的**纯亮度直方图**（FastStone 风格，Rec.709 单通道 256 bin，灰白填充+细描边，带 0/64/128/192/255 值域刻度，悬停显示该 bin 像素数与占比） |
| 全屏策略 | **双击三层交互链**：对比 / 网格中双击某格 → L1 该格控件全屏（隐藏侧栏与胶片条）→ 再双击 → L2 物理全屏（Fullscreen API）→ 再双击 → L3 循环切换全屏显示源（对比 A↔B、网格下一格；**槽位 / 格组内容本身不变**，只切显示哪一格；单图无源可切，双击为适应 ↔ 100%）。F 键 = 单图 / 对比激活格 / 网格当前格的控件全屏开关（链的 L1）；Shift+F = 当前视图整体直进物理全屏。**物理全屏 = 真全屏**：卸载工具栏/侧栏/胶片条等一切应用 chrome，只留图像 + 信息浮层/直方图（若开启）+ 悬浮半透明迷你条（顶部热区淡入淡出，含「退出物理全屏」「退出全屏」）；退出后恢复进入前状态（fullscreenchange 同步，Esc 按 物理 → 控件全屏 → 浏览 逐级退出） |
| 文件操作 | Electron 走 IPC（删除进回收站；拖放走主进程递归复制）；浏览器 FS Access 走句柄（删除为直删有警示；拖放经 `webkitGetAsEntry` 递归写入，带进度提示）；webkitdirectory 回退禁用写操作 |

## 截图

> 待补充：运行 `TWINVIEW_SMOKE=1` 冒烟测试可生成主界面截图 `smoke-home.png`（该文件不入库），或手动截图后放入 `docs/screenshots/` 并在此引用。

```
![主界面](docs/screenshots/main.png)        ← 浏览 + 胶片条
![并排对比](docs/screenshots/compare.png)    ← A/B 并排 + 信息浮层 + 直方图
![划变对比](docs/screenshots/wipe.png)       ← 划变分割线 + ALT 探针浮签
```

## 快捷键

| 按键 | 功能 |
| --- | --- |
| ← / → 或 PgUp / PgDn | 上一张 / 下一张（按当前导航范围循环）。单图：切当前图；**对比：切激活槽位的图**（Tab 切激活侧，优先跳过另一槽占据项；集合内无其他项时允许与另一槽同图，如仅勾选 2 张占满 A/B）；**网格：切激活格**（优先跳过其他格占据项，无其他项时同样允许同图） |
| R / L | 向右 / 向左旋转 90°（仅视图层，不写文件） |
| F | 单图 / 对比激活格 / 网格当前格 = 进入或退出该格控件全屏（双击链第一层） |
| Shift+F | 物理全屏（隐藏浏览器 / 窗口边框）：作用于当前视图整体，自动带悬浮迷你条 |
| Alt（按住） | 颜色探针：浮签显示原图坐标与 RGB；ALT+单击记录到侧栏取样列表 |
| 1 | 实际大小 100%（单图 / 对比）；网格中为激活第 1 格 |
| 1 – 9 | 网格模式：激活第 N 格 |
| 双击图片 | 单图：适应窗口 ↔ 100%；对比 / 网格：三层链 —— 控件全屏 → 物理全屏 → 循环切换显示源（A↔B / 下一格，槽位与格组内容不变） |
| Esc | 物理全屏 → 控件全屏 → 返回浏览模式（逐级，保留勾选） |
| 滚轮 / 拖拽 | 以鼠标为中心缩放 / 平移图片 |
| I | 显示 / 隐藏信息浮层（基本 + EXIF；直方图由工具栏独立开关） |
| 空格 | 勾选 / 取消勾选当前图片 |
| Backspace | 浏览模式：返回上级文件夹（面包屑 / 文件夹树 / 网格三处状态一致） |
| 双击文件夹 | 进入该文件夹（网格 / 列表中文件夹排在图片前，带预览拼贴与计数） |
| A / B | 浏览 / 单图：把当前图片设为 A / B 槽；对比：选定激活侧 |
| Tab | 对比：切换激活侧（A ↔ B）；网格：循环激活格 |
| X / W / G / N | 交换 A/B ｜ 循环对比布局（划变/并排/叠化）｜ 同 W ｜ 对比下一对 / 网格下一组 |
| D | 差值热图开关（对比第 4 种布局；再按返回之前布局；colormap 与容差在工具条调） |
| S | 录制显示区：开录前配置对话框（MP4/GIF + 画质档；GIF 可选连续采样/切换抓帧，记住上次选择）→ 倒计时开始（可取消）→ 录制中 → **再按立即停止** → 系统保存对话框选位置（不再询问格式/画质） |
| C | GIF 切换抓帧录制中：手动补抓一帧（徽标帧数 +1） |
| ? | 打开 / 关闭快捷键帮助 |

## 快速开始

```bash
npm install            # 首次

# 网页版（浏览器完整功能，Chrome/Edge 最佳）
npm run dev            # http://localhost:7100

# 桌面版开发（Vite dev server + Electron 窗口）
npm run electron:dev

# 本地打包（先构建网页版，再用 electron-builder 产出安装包到 release/）
npm run electron:build

# 生产构建与预览
npm run build && npm run preview
```

CI：每次 push 到 `main`，GitHub Actions 先跑类型检查 + 网页构建（`verify`），再在 windows-latest / macos-latest 上分别产出 NSIS 与 arm64 DMG，滚动发布到 [nightly 预发布](https://github.com/congyong/TwinViewer/releases/tag/nightly)（同名资产覆盖，commit SHA 写在 release 正文）。

### 冒烟测试（桌面版自检）

```bash
npm run build   # 冒烟加载 dist，需先构建
TWINVIEW_SMOKE=1 NODE_ENV=production ./node_modules/electron/dist/electron.exe . 2>&1 | tee smoke-output.txt
```

自动校验目录扫描 / list-dirs / path-ancestors / read-file-buffer（含像素非零断言）/ 文件操作三件套 / 打开对话框 IPC（special-dirs / browse-dir / dir-image-preview 递归+shallow 本层断言）/ **UI 自动化（自动打开测试目录，断言递归关 8 张 ↔ 开 10 张、子文件夹卡片、面包屑、列表模式行数、Backspace 返回、主题亮/暗切换、打开文件夹对话框渲染）** / **CLI 注入（cli-open folder+file 定位选中、--compare 槽位/布局/主题 flag）** / **真全屏布局（状态级模拟 chrome 卸载/恢复）+ 槽位导航（仅勾选占满时回退同图且无提示、全部档步进跳过、激活侧切换、swap 回归、网格跳过与回退同图）** / **视图级物理全屏（Shift+F 直进：对比 2 pane / 网格 4 pane 布局不变 + 悬浮迷你条 + chrome 全卸载，退出恢复）** / **双击三层链（事件级 dblclick 进 L1 控件全屏；action 触发物理全屏请求 + 状态级模拟 L2；L3 对比 A↔B 槽位内容不变、网格 0→1→2 格组不变；退出 chrome 恢复）** / **树点击回浏览（对比模式下模拟树节点点击 → viewMode=browse 且 currentPath 正确；浏览中点击不变；Esc 回归）** / **差值热图（配置面板仅 diff 可见+容差滑块联动 store、diff canvas 挂载、同图全黑、异图非黑、单元级合成位图验证容差单调抑制/置黑阈值、四种必需 colormap inferno/gray/viridis/coolwarm 齐全有序且可切换、coolwarm 中点近白/两端蓝红、gray 消色差、**直方图均衡默认开+面板开关联动+max 显示、8 灰级差合成图均衡开高亮 >0.7 / 关 <0.1、全同图仍全黑**）** / **录制状态机（先配置后开录 + 立即停止：S 出配置对话框、选 GIF/低画质并断言持久化、取消/Esc 回 idle、再开记住上次选择、确认进 starting 倒计时、采集（headless 真实采集成功）、S 立即停止无 stopping 中间态、saving 自动弹系统保存（冒烟模拟取消）、保存参数与开录前一致、放弃回 idle；GIF 画质单元：gif-core 档位计划/尺寸上限/字节预算/合成帧编码合法；GIF 切换抓帧端到端：默认方式 switch + 默认帧间 0.5s、配置框帧间时长输入联动、switch 模式开录首帧不自抓、两次槽位切换 + C 手动帧 = 3 帧且徽标同步、帧尺寸 = 显示区设备像素原尺寸（≤2560 封顶）、立即停止、编码 GIF 合法且 GCE delay 全为固定帧间时长（设 0.8s → 全 80×1/100s）、放弃回 idle）** / twinview:// 协议链路，截屏保存 `smoke-home.png`（含网格与文件夹拼贴画面），全部通过打印 `[SMOKE] 全部通过` 并退出。

## CLI 与集成

桌面版可被其他应用/脚本命令行调用（**单实例**：已运行则参数转发给现有窗口焦点前置执行，不新开窗口）：

| 用法 | 行为 |
| --- | --- |
| `TwinView.exe <文件夹>` | 直接打开该文件夹 |
| `TwinView.exe <图片文件>` | 打开其所在文件夹并定位/选中该文件 |
| `TwinView.exe --compare <A> <B>` | 打开共同（或 A 的）所在文件夹，A/B 入槽进入对比 |
| `--recursive` | 本次会话开「含子文件夹」 |
| `--theme dark\|light\|system` | 指定主题 |
| `--layout wipe\|side\|overlay\|diff\|grid` | 对比显示模式（配合 `--compare`） |
| `--help` | 打印用法到 stdout |

未识别参数忽略并警告到 stdout；路径不存在/不可读仅警告不动作；CLI 下发直接生效（不弹任何确认）。**dev 模式**：`npm run dev` 另开终端 `npm run electron:cli -- <args>`（或 `./node_modules/.bin/electron . -- <args>`）；`npm run electron:dev -- <args>` 不透传参数（concurrently 限制）。

**Kimi Work 集成**：已注册 skill `twinview`（`daimon-share/daimon/skills/twinview/SKILL.md`，仓库副本 `skills/twinview/SKILL.md` 同步维护），Kimi 可按需通过 CLI 唤起 TwinView 浏览/对比图片。

## 持久化配置项

所有用户偏好收口在单个 localStorage key `twinview.settings`（`{version:1, values}`，启动时逐字段校验，旧版散 key 自动迁移一次）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `recursive` | `false` | 含子文件夹（浏览视野是否递归） |
| `theme` | `dark` | 主题：`dark` / `light` / `system`（跟随系统，监听系统切换） |
| `browseMode` | `medium` | 显示模式：`large` / `medium` / `small` / `list` |
| `sortKey` / `sortAsc` | `name` / `true` | 排序键（名称/日期/大小）与方向 |
| `resample` | `auto` | 缩放算法：`auto` / `nearest` / `bifant` / `bilinear` / `bicubic` / `lanczos` |
| `navScope` | `all` | 导航范围：`all`（全部）/ `checked`（仅勾选） |
| `compareLayout` | `wipe` | 对比布局：`wipe` / `side` / `overlay` |
| `splitRatio` / `wipeRatio` / `overlayOpacity` | `0.5` / `0.5` / `0.5` | 并排比例 / 划变线位置 / 叠化透明度 |
| `histoVisible` | `false` | 直方图显隐 |
| `favorites` | `[]` | 收藏夹（路径 + 名称） |

### 软件重采样算法说明

| 算法 | 特性 |
| --- | --- |
| BIFant | 盒式**真面积平均**（Fant，support 0.5）：权重 = 输出像素源足迹与每个源像素的覆盖长度（边缘像素按比例部分计入），**缩小最干净**，接近整数倍缩小无混叠；放大为平滑线性混合 |
| 双线性 | 三角核（support 1），速度快、效果均衡 |
| 双立方 | Catmull-Rom（a=-0.5，support 2），锐利但边缘略过冲 |
| Lanczos-3 | sinc 加窗（support 3），**质量最佳**、最慢，缩略图首选 |

实现为 CPU 可分离两遍卷积（先水平后垂直，Float32 中间缓冲），缩小时核按 1/scale 加宽抗混叠；贡献窗按像素中心（p+0.5）对齐核支撑；权重按输出像素预计算并归一化；分片 `setTimeout(0)` 让出主线程且可取消；结果按 `条目|算法|尺寸` LRU 缓存 8 张；canvas 目标尺寸夹取 4096px。回归校验：`npm run verify:bifant`（合成渐变+网格在 50/78/100/150% 跑 BIFant，断言行列均值无周期尖峰、能量守恒）。

## 技术栈与架构

- **渲染进程**：React 19 + TypeScript + zustand；Vite + Tailwind + shadcn/ui
- **桌面壳**：Electron（CommonJS 主进程 + contextBridge preload，`window.twinview` 最小 IPC 桥，contextIsolation 开启）
- **fs-provider 双实现**：运行时探测——存在 `window.twinview` 用 `ElectronFSProvider`（IPC + `twinview://` 自定义协议免拷贝读图），否则用 `BrowserFSProvider`（File System Access API，Firefox/Safari 自动回退 webkitdirectory）；同一套 UI 零分支
- **decode-cache 会话解码缓存**：ImageBitmap 优先；字节预算 1GB 的 LRU + 在显 pin 保护；`peekDecoded` 同步命中配合 ViewerPane 双缓冲帧模型实现无缝切图；Electron 下经 `read-file-buffer` IPC 取字节转 blob 解码，canvas 不被 twinview:// 污染（直方图 / EXIF / ALT 探针共享此缓存）

更深入的模块关系、IPC 清单与维护规约见 **[HANDOVER.md](HANDOVER.md)**。

## 已知限制

- macOS 构建为 **ad-hoc 签名**（无开发者证书，electron-builder 回退 `codesign -s -`；arm64 完全无签名会被 Gatekeeper 判「已损坏」）：首次打开需「右键 → 打开」；若仍提示已损坏，执行 `xattr -dr com.apple.quarantine /Applications/TwinView.app`；仅提供 arm64（Apple Silicon）DMG
- 系统选择器的「文件/文件夹同时可选」仅 win32（`openFile`+`openDirectory` 并用）；其他平台保持仅选文件夹
- CLI 仅桌面 Electron 形态支持（网页版无）；相对路径按调用方 cwd 解析，建议绝对路径
- 浏览器模式无法访问所开文件夹的上级目录（浏览器安全模型），祖先链仅 Electron 可用
- 浏览器回退模式（Firefox/Safari）：始终递归选择、目录树只能反推、**不支持写操作与拖放写入**
- 浏览器 FS Access 的删除为 `handle.remove()` 直删、不进回收站（UI 有警示，需 Chrome 110+）；Electron 删除进回收站
- 软件重采样（BIFant/双线性/双立方/Lanczos）为 CPU 逐像素卷积：大图连续缩放时先平滑预览、停手 ~150ms 后出精确图；canvas 目标尺寸夹取 4096px
- ALT 探针离屏 canvas 最长边 4096px（超大图按比例取样），缓存上限 4 张；**diff 差值布局下 ALT 探针不可用**（显示的是合成热图而非源图）
- 录制：Electron 采集整个本窗口再按显示区 rect 裁剪（录不到系统声音；窗口被最小化/遮挡区域画面由系统合成器决定）；MP4 容器依赖 Chromium 的 MediaRecorder 支持，不可用时自动落 **WebM**（UI 明示）；**视频码率按画质档于录制开始时确定**（保存对话框中改画质只影响下次录制）；GIF 连续采样按画质档采集与编码（高 15fps·≤1280 宽·256 色 FS 抖动·末尾 20 秒，中 12fps·720 宽·30 秒，低 8fps·480 宽·128 色·30 秒；高档 300 帧 720p RGBA ≈1.1GB 内存，超大裁剪按 1.25GB 预算缩帧兜底）；GIF 切换抓帧全分辨率不降采样（仅 >2560 宽封顶）、上限 60 帧（1080p ≈456MB / 1440p ≈885MB RGBA，同样受 1.25GB 预算缩帧兜底）、图像变化后 400ms 去抖抓帧（等解码上屏，期间连续变化只抓最后一次）、全程零变化时停止补抓当前帧兜底、帧间时长为固定配置值（非真实墙钟间隔，快速连切的播放节奏均匀）；浏览器模式经 getDisplayMedia 采集（可能包含浏览器 UI，取决于用户选择的共享目标），保存 = 触发下载（无法选择位置）
- 超大文件夹（数万张）未做虚拟滚动；网格对比最多 9 张
- AVIF / TIFF 等格式依赖浏览器自身解码能力；旋转仅为视图层效果，不写回文件

## 目录结构速览

```
twinview/
├─ .github/workflows/build-release.yml   CI：verify → 双平台打包 → nightly 滚动预发布
├─ electron/
│  ├─ main.cjs                           主进程：窗口 / 菜单 / IPC × 8 / twinview:// 协议 / 冒烟测试
│  └─ preload.cjs                        contextBridge 暴露 window.twinview
├─ src/
│  ├─ App.tsx                            布局骨架（工具栏 / 侧栏 / 主区 / 胶片条 / 帮助浮层）
│  ├─ store/appStore.ts                  zustand 全局状态与全部 Action
│  ├─ hooks/useKeyboard.ts               全局快捷键分流
│  ├─ lib/
│  │  ├─ fs-provider.ts                  文件系统抽象（浏览器 / Electron 双实现）
│  │  ├─ decode-cache.ts                 会话解码缓存（1GB 字节预算 LRU + pin + peekDecoded）
│  │  ├─ pixel-probe.ts                  ALT 颜色探针像素读取（离屏 canvas，LRU 4）
│  │  ├─ diffmap.ts                      差值热图（max abs diff + 容差 + 4 种 colormap LUT）
│  │  ├─ gif-core.ts                     GIF 编码核心（画质档计划 + rgb888 全局调色板 + FS 抖动，纯函数）
│  │  ├─ recorder.ts                     显示区录制（desktopCapturer/getDisplayMedia → 镜像裁剪 → MediaRecorder/gif-core）
│  │  ├─ image-info.ts                   直方图抽样 + EXIF 读取（按图缓存）
│  │  ├─ file-ops.ts                     复制 / 粘贴 / 新建文件夹 / 删除（双实现）
│  │  ├─ dir-tree.ts                     目录树工具（三种数据源 → DirNode）
│  │  └─ format.ts / utils.ts            格式化与 classnames
│  └─ components/
│     ├─ ViewerPane.tsx                  核心查看窗格（双缓冲帧模型 / 缩放平移 / wipe / 探针）
│     ├─ DiffPane.tsx                    差值热图窗格（diff 布局；交互与 ViewerPane 对齐）
│     ├─ RecordOverlay.tsx               录制叠层（倒计时胶囊 / 红点徽标 / 保存对话框）
│     ├─ CompareView.tsx                 A/B 对比（划变 / 并排 / 叠化 / 差值 + 单格控件全屏）
│     ├─ CompareGrid.tsx                 多图网格对比（自动布局 / 同步独立 / 单格控件全屏）
│     ├─ SingleView.tsx                  单图视图（含应用内全屏）
│     ├─ ThumbnailGrid.tsx / Filmstrip.tsx / Sidebar.tsx / Toolbar.tsx
│     ├─ InfoOverlay.tsx / StatusBar.tsx / HelpOverlay.tsx / EmptyState.tsx
│     ├─ FileOpsMenu.tsx / FullscreenMiniBar.tsx
│     └─ ui/                             shadcn/ui 组件
├─ HANDOVER.md                           维护者交接文档
└─ package.json                          脚本与 electron-builder 配置（win nsis / mac dmg，mac.identity=null）
```

---

所有文件仅在本机读取，绝不上传。
