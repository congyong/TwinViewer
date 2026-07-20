---
name: twinview
description: 当需要在本机用 TwinView 浏览文件夹图片、定位选中某张图片、或对比两张图片（A/B 划变/并排/叠化/网格）时使用。TwinView 支持 CLI 调用与单实例转发，可被脚本或其他应用命令行唤起。
---

# TwinView 图片对比浏览器（本机集成）

TwinView 是用户本机的 Electron + React 图片对比浏览器：浏览文件夹（缩略图/列表/子文件夹）、A/B 对比（划变/并排/叠化）、多图网格、EXIF/直方图/ALT 颜色探针、文件操作与拖放复制。

## 安装/构建状态

- 源码仓库：`C:\Users\ISP14\Documents\kimi\workspace\twinview`（remote: github.com/congyong/TwinViewer，main 分支持续更新）。
- **dev 模式（当前可用）**：需要 dev server 在线（Kimi Work 托管的 7100 预览，或手动 `npm run dev`），然后：
  ```bash
  cd C:\Users\ISP14\Documents\kimi\workspace\twinview
  npm run electron:cli -- <args>        # wait-on 7100 后 electron . -- <args>
  # 等价手动：先 npm run dev，再 ./node_modules/.bin/electron . -- <args>
  ```
  注意 `npm run electron:dev -- <args>` **不透传**参数（concurrently 限制），请用 `electron:cli`。
- **打包版**：`npm run electron:build` 产出 `release/` 下 NSIS 安装包（win x64）/ DMG（mac arm64，未签名）；安装后 `TwinView.exe <args>`。nightly 预发布由 CI 滚动更新（见仓库 Releases）。
- 调用前先确认哪种形态可用：打包版看 `TwinView.exe` 是否存在；否则用 dev 模式并确保 7100 已起。

## CLI 用法

```
TwinView.exe <文件夹>                    打开文件夹
TwinView.exe <图片文件>                  打开所在文件夹并选中该图片
TwinView.exe --compare <图片A> <图片B>   打开共同所在文件夹并进入 A/B 对比
可选参数:
  --recursive                      本次会话开启「含子文件夹」
  --theme dark|light|system        指定主题
  --layout wipe|side|overlay|grid  对比显示模式（配合 --compare；grid=多图网格）
  --help                           打印用法到 stdout
```

示例：

```bash
# 浏览下载目录（dev 模式）
npm run electron:cli -- "C:\Users\ISP14\Downloads"

# 定位某张图（打开所在文件夹并选中）
npm run electron:cli -- "D:\photos\IMG_0001.jpg"

# 对比两张图，并排布局 + 亮色主题
npm run electron:cli -- --compare "D:\a.jpg" "D:\b.jpg" --layout side --theme light
```

## 行为与限制

- **单实例**：已运行时再调用 = 参数经 second-instance 转发给现有窗口（焦点前置，按参数打开/对比），不新开窗口；无窗口才新启动。
- **路径要求**：绝对路径；相对路径按调用方 cwd 解析（Electron 默认），建议始终传绝对路径。路径不存在/不可读 → stdout 警告，不动作。
- **未识别参数**：忽略并警告到 stdout，不影响其他参数。
- **--compare 目录解析**：打开 A、B 的最深公共目录（扫描恒递归，B 在 A 的子目录也能找到）；不同盘符无公共目录时打开 A 所在文件夹，B 找不到则仅设 A 槽并 warn。
- **退出码**：CLI 本身不改变退出码（0=正常；冒烟自检模式 `TWINVIEW_SMOKE=1` 失败时退出码 1）。
- **不弹确认**：CLI 下发直接生效（打开/对比），不经过任何确认弹窗。
- 网页版（纯浏览器）不支持 CLI；CLI 仅桌面 Electron 形态。

## 维护

- 本 skill 有两处副本，内容需保持同步：
  - 注册位置：`C:\Users\ISP14\AppData\Roaming\kimi-desktop\daimon-share\daimon\skills\twinview\SKILL.md`
  - 仓库副本：`twinview/skills/twinview/SKILL.md`（随 git 管理）
- 架构、IPC 清单、修改规约见仓库 `HANDOVER.md`；CLI 参数解析在 `electron/main.cjs`（parseCliArgs/dispatchCli），渲染端入口 `appStore.applyCliOpen`。
