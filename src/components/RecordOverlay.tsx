/**
 * 录制 UI 叠层（挂在显示区列上，absolute 覆盖查看区）：
 * - starting/stopping：中央半透明胶囊倒计时（「3S 后开始录制 / 3S 后停止录制（再按 S 取消）」）
 * - recording：右上角红点计时徽标
 * - saving：保存对话框（格式 MP4/GIF + 画质 高/中/低 + 保存/取消；
 *   MP4 不可用落 WebM 明示；浏览器模式只能触发下载）
 */
import { useAppStore } from '@/store/appStore'

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const QUALITIES: { value: 'high' | 'medium' | 'low'; label: string }[] = [
  { value: 'high', label: '高' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低' },
]

export function RecordOverlay() {
  const phase = useAppStore((s) => s.recPhase)
  const countdown = useAppStore((s) => s.recCountdown)
  const elapsed = useAppStore((s) => s.recElapsed)
  const mime = useAppStore((s) => s.recMime)
  const format = useAppStore((s) => s.recFormat)
  const quality = useAppStore((s) => s.recQuality)
  const providerKind = useAppStore((s) => s.providerKind)
  const setRecFormat = useAppStore((s) => s.setRecFormat)
  const setRecQuality = useAppStore((s) => s.setRecQuality)
  const saveRecording = useAppStore((s) => s.saveRecording)
  const cancelSave = useAppStore((s) => s.cancelSave)

  if (phase === 'idle') return null

  return (
    <>
      {(phase === 'starting' || phase === 'stopping') && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center">
          <div data-rec-pill className="flex items-center rounded-full bg-black/70 px-5 py-2.5 text-sm text-white shadow-lg">
            <span>{phase === 'starting' ? `${countdown}S 后开始录制` : `${countdown}S 后停止录制`}</span>
            <span className="ml-3 inline-block w-6 text-center text-lg font-bold text-red-400">{countdown}</span>
            {phase === 'stopping' && <span className="ml-2 text-xs text-neutral-300">再按 S 取消</span>}
          </div>
        </div>
      )}

      {phase === 'recording' && (
        <div
          data-rec-badge
          className="absolute right-3 top-3 z-40 flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1 text-xs font-medium text-white shadow"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
          {fmtElapsed(elapsed)}
        </div>
      )}

      {phase === 'saving' && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50" data-rec-save>
          <div className="w-80 rounded-lg border border-[var(--tv-border2)] bg-[var(--tv-bg)] p-4 shadow-xl">
            <h3 className="mb-3 text-sm font-semibold text-[var(--tv-text)]">保存录制</h3>

            <div className="mb-3 flex gap-2">
              <button
                data-rec-format-video
                className={`flex-1 rounded border px-2 py-1.5 text-xs ${
                  format === 'video'
                    ? 'border-sky-500 bg-sky-600/20 text-sky-300'
                    : 'border-[var(--tv-border2)] text-[var(--tv-text-dim)]'
                }`}
                onClick={() => setRecFormat('video')}
              >
                视频（{mime.includes('mp4') ? 'MP4' : 'WebM'}）
              </button>
              <button
                data-rec-format-gif
                className={`flex-1 rounded border px-2 py-1.5 text-xs ${
                  format === 'gif'
                    ? 'border-sky-500 bg-sky-600/20 text-sky-300'
                    : 'border-[var(--tv-border2)] text-[var(--tv-text-dim)]'
                }`}
                onClick={() => setRecFormat('gif')}
              >
                GIF
              </button>
            </div>

            {format === 'video' && mime !== '' && !mime.includes('mp4') && (
              <p className="mb-2 text-xs text-amber-400">当前环境 MP4 不可用，已录制为 WebM</p>
            )}
            {format === 'video' && mime === '' && (
              <p className="mb-2 text-xs text-amber-400">当前环境 MediaRecorder 不可用，无视频输出 — 请改选 GIF</p>
            )}
            {format === 'gif' && (
              <p className="mb-2 text-xs text-[var(--tv-text-dim)]">GIF 10fps，最多取录制末尾 30 秒</p>
            )}

            <div className="mb-1 flex items-center gap-2">
              <span className="text-xs text-[var(--tv-text-dim)]">画质</span>
              <div className="flex gap-1">
                {QUALITIES.map((q) => (
                  <button
                    key={q.value}
                    data-rec-quality={q.value}
                    className={`rounded border px-2.5 py-1 text-xs ${
                      quality === q.value
                        ? 'border-sky-500 bg-sky-600/20 text-sky-300'
                        : 'border-[var(--tv-border2)] text-[var(--tv-text-dim)]'
                    }`}
                    onClick={() => setRecQuality(q.value)}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="mb-3 text-[11px] text-[var(--tv-text-faint)]">
              {format === 'gif' ? '影响 GIF 色数与缩放' : '影响码率（于录制开始时按档位确定）'}
            </p>

            {providerKind === 'browser' && (
              <p className="mb-3 text-[11px] text-[var(--tv-text-faint)]">浏览器模式：保存 = 触发下载（无法选择位置）</p>
            )}

            <div className="flex justify-end gap-2">
              <button
                data-rec-cancel
                className="rounded border border-[var(--tv-border2)] px-3 py-1.5 text-xs text-[var(--tv-text-dim)] hover:bg-[var(--tv-hover)]"
                onClick={cancelSave}
              >
                取消
              </button>
              <button
                data-rec-save-ok
                className="rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
                onClick={() => void saveRecording()}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
