/**
 * 主题应用：暗 / 亮 / 跟随系统
 * - dark class 挂 <html>（Tailwind darkMode: 'class'）；CSS 变量见 index.css（:root 亮 / .dark 暗）
 * - system = prefers-color-scheme + change 监听（全局只注册一次）
 * - Electron 下同步窗口背景色（setWindowBackground IPC），避免启动/切换时闪白闪黑
 */
import type { ThemeMode } from '@/lib/settings'

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return true
  }
}

export function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
  return mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode
}

let listening = false
let currentMode: ThemeMode = 'dark'

/** 应用主题到 DOM（+ Electron 窗口背景）；mode 变化时可重复调用 */
export function applyTheme(mode: ThemeMode): void {
  currentMode = mode
  const resolved = resolveTheme(mode)
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved
  // 窗口/首帧背景（与 CSS 变量 --tv-bg 一致），Electron 同步原生窗口
  const bg = resolved === 'dark' ? '#1e1e1e' : '#ececec'
  document.body.style.backgroundColor = bg
  try {
    window.twinview?.setWindowBackground?.(bg)
  } catch {
    /* 非 Electron 环境忽略 */
  }
  if (mode === 'system' && !listening) {
    listening = true
    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (currentMode === 'system') applyTheme('system')
      })
    } catch {
      /* 旧内核无 addEventListener 时忽略（不跟随系统切换） */
    }
  }
}
