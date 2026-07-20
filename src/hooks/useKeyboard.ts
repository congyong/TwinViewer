import { useEffect } from 'react'
import { getNavList, useAppStore } from '@/store/appStore'

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
}

export function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) return
      if (isEditableTarget(e.target)) return
      const s = useAppStore.getState()
      const key = e.key.toLowerCase()

      // Shift+F：单格全屏中切换物理全屏（Fullscreen API）
      if (key === 'f' && e.shiftKey) {
        if (s.fullscreenCell) {
          void s.togglePhysicalFullscreen()
          e.preventDefault()
        }
        return
      }
      if (e.altKey) return

      // ---------- 帮助 ----------
      if (e.key === '?') {
        s.toggleHelp()
        e.preventDefault()
        return
      }
      if (s.helpOpen) {
        if (key === 'escape') s.toggleHelp()
        return
      }

      // ---------- 全局 ----------
      if (key === 'escape') {
        // 退出顺序：物理全屏 → 控件内单格全屏 → 浏览模式
        if (s.physicalFullscreen) {
          void s.togglePhysicalFullscreen()
          return
        }
        if (s.fullscreenCell) {
          s.setFullscreenCell(null)
          return
        }
        if (s.viewMode !== 'browse') {
          s.setViewMode('browse')
          e.preventDefault()
        }
        return
      }
      if (key === 'i') {
        if (s.viewMode !== 'browse') s.toggleInfo()
        return
      }
      if (key === 'f') {
        // F 键按模式分流：单图 / 对比 / 网格 = 进入或退出对应全屏（控件内）
        if (s.viewMode === 'single') s.setFullscreenCell(s.fullscreenCell === 'single' ? null : 'single')
        else if (s.viewMode === 'compare') s.setFullscreenCell(s.fullscreenCell ? null : s.activeSlot)
        else if (s.viewMode === 'grid') s.setFullscreenCell(s.fullscreenCell ? null : String(s.gridActiveIdx))
        return
      }
      if (key === 'r') {
        if (s.viewMode !== 'browse') {
          s.rotateCurrent(1)
          e.preventDefault()
        }
        return
      }
      if (key === 'l') {
        if (s.viewMode !== 'browse') {
          s.rotateCurrent(-1)
          e.preventDefault()
        }
        return
      }
      if (key === 'tab') {
        e.preventDefault()
        if (s.viewMode === 'compare') s.toggleActiveSlot()
        else if (s.viewMode === 'grid' && s.gridIds.length > 0) {
          s.setGridActiveIdx((s.gridActiveIdx + 1) % s.gridIds.length)
        }
        return
      }
      if (key === '1' && (s.viewMode === 'single' || s.viewMode === 'compare')) {
        s.resetView('actual')
        return
      }

      // ---------- 浏览模式 ----------
      if (s.viewMode === 'browse') {
        const nav = getNavList(s)
        const cur = nav.findIndex((x) => x.id === s.currentId)
        if (key === 'enter') {
          if (s.currentId) s.enterSingle(s.currentId)
          e.preventDefault()
        } else if (key === 'backspace') {
          s.navigateUp()
          e.preventDefault()
        } else if (key === 'a' || key === 'b') {
          s.assignCurrentToSlot(key.toUpperCase() as 'A' | 'B')
          e.preventDefault()
        } else if (key === ' ') {
          if (s.currentId) s.toggleChecked(s.currentId)
          e.preventDefault()
        } else if (key === 'arrowleft' || key === 'pageup' || key === 'arrowright' || key === 'pagedown') {
          if (nav.length === 0) return
          const delta = key === 'arrowleft' || key === 'pageup' ? -1 : 1
          const next = cur < 0 ? (delta > 0 ? 0 : nav.length - 1) : (cur + delta + nav.length) % nav.length
          s.setCurrent(nav[next].id)
          e.preventDefault()
        }
        return
      }

      // ---------- 单图 ----------
      if (s.viewMode === 'single') {
        if (key === 'arrowleft' || key === 'pageup') {
          s.navigate(-1)
          e.preventDefault()
        } else if (key === 'arrowright' || key === 'pagedown') {
          s.navigate(1)
          e.preventDefault()
        } else if (key === ' ') {
          if (s.currentId) s.toggleChecked(s.currentId)
          e.preventDefault()
        } else if (key === 'a' || key === 'b') {
          s.assignCurrentToSlot(key.toUpperCase() as 'A' | 'B')
        }
        return
      }

      // ---------- A/B 对比 ----------
      if (s.viewMode === 'compare') {
        if (key === 'a' || key === 'b') {
          const target = key.toUpperCase() as 'A' | 'B'
          if (s.activeSlot !== target) s.toggleActiveSlot()
        } else if (key === 'x') {
          s.swapSlots()
        } else if (key === 'g' || key === 'w') {
          s.cycleCompareLayout()
        } else if (key === 'n') {
          s.nextPair()
        } else if (key === ' ') {
          const id = s.activeSlot === 'A' ? s.slotA : s.slotB
          if (id) s.toggleChecked(id)
          e.preventDefault()
        } else if (key === 'arrowleft' || key === 'pageup') {
          s.navigate(-1)
          e.preventDefault()
        } else if (key === 'arrowright' || key === 'pagedown') {
          s.navigate(1)
          e.preventDefault()
        }
        return
      }

      // ---------- 多图网格 ----------
      if (s.viewMode === 'grid') {
        if (key === 'n') {
          s.nextBatch()
        } else if (/^[1-9]$/.test(key)) {
          const idx = parseInt(key, 10) - 1
          if (idx < s.gridIds.length) s.setGridActiveIdx(idx)
        } else if (key === ' ') {
          const id = s.gridIds[s.gridActiveIdx]
          if (id) s.toggleChecked(id)
          e.preventDefault()
        } else if (key === 'arrowleft' || key === 'pageup') {
          s.navigate(-1)
          e.preventDefault()
        } else if (key === 'arrowright' || key === 'pagedown') {
          s.navigate(1)
          e.preventDefault()
        }
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
