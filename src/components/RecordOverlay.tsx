/**
 * 录制 UI 叠层（挂在显示区列上，absolute 覆盖查看区）：
 * - configuring：开录前配置对话框（格式 MP4/GIF + 画质 高/中/低；GIF 抓帧方式 连续采样/切换抓帧（默认），
 *   切换抓帧另有帧间时长 0.1–5 秒；均默认取上次选择并持久化；「开始录制」→ 倒计时，「取消」/ Esc → 回 idle）
 * - starting：中央半透明胶囊倒计时（「3S 后开始录制」，再按 S 取消）
 * - recording：右上角红点计时徽标（再按 S = **立即停止**进 saving，无停止倒计时）
 * - saving：停止后自动按开录前选择弹系统保存对话框（不再询问格式/画质）；
 *   用户取消路径选择或保存失败时叠层提供「重试保存 / 放弃录制」
 *   （MP4 不可用在配置对话框已明示并落 WebM；浏览器模式只能触发下载）
 */
import { useAppStore } from '@/store/appStore'
import { pickVideoMime } from '@/lib/recorder'

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

const GIF_MODES: { value: 'continuous' | 'switch'; label: string }[] = [
  { value: 'continuous', label: '连续采样' },
  { value: 'switch', label: '切换抓帧' },
]

export function RecordOverlay() {
  const phase = useAppStore((s) => s.recPhase)
  const countdown = useAppStore((s) => s.recCountdown)
  const elapsed = useAppStore((s) => s.recElapsed)
  const mime = useAppStore((s) => s.recMime)
  const format = useAppStore((s) => s.recFormat)
  const quality = useAppStore((s) => s.recQuality)
  const gifMode = useAppStore((s) => s.recGifMode)
  const gifSec = useAppStore((s) => s.recGifFrameSec)
  const frameCount = useAppStore((s) => s.recFrameCount)
  const providerKind = useAppStore((s) => s.providerKind)
  const setRecFormat = useAppStore((s) => s.setRecFormat)
  const setRecQuality = useAppStore((s) => s.setRecQuality)
  const setRecGifMode = useAppStore((s) => s.setRecGifMode)
  const setRecGifFrameSec = useAppStore((s) => s.setRecGifFrameSec)
  const confirmRecConfig = useAppStore((s) => s.confirmRecConfig)
  const cancelRecConfig = useAppStore((s) => s.cancelRecConfig)
  const saveRecording = useAppStore((s) => s.saveRecording)
  const cancelSave = useAppStore((s) => s.cancelSave)

  if (phase === 'idle') return null

  // 配置时尚未开录（recMime 未定）：实时探测容器给视频格式标注（与实际开录探测同一函数）
  const probedMime = phase === 'configuring' ? pickVideoMime() : mime
  const videoLabel = `视频（${probedMime.includes('mp4') ? 'MP4' : 'WebM'}）`
  const formatLabel = format === 'gif' ? 'GIF' : probedMime.includes('mp4') ? 'MP4' : 'WebM'
  const qualityLabel = QUALITIES.find((q) => q.value === quality)?.label ?? quality

  const formatButtons = (
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
        {videoLabel}
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
  )

  const qualityRow = (
    <>
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
        {format === 'gif' ? '影响 GIF 帧率 / 分辨率 / 色数 / 时长上限' : '影响码率（于录制开始时按档位确定）'}
      </p>
    </>
  )

  return (
    <>
      {phase === 'configuring' && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50" data-rec-config>
          <div className="w-80 rounded-lg border border-[var(--tv-border2)] bg-[var(--tv-bg)] p-4 shadow-xl">
            <h3 className="mb-3 text-sm font-semibold text-[var(--tv-text)]">录制设置</h3>

            {formatButtons}

            {format === 'video' && probedMime !== '' && !probedMime.includes('mp4') && (
              <p className="mb-2 text-xs text-amber-400">当前环境 MP4 不可用，将录制为 WebM</p>
            )}
            {format === 'video' && probedMime === '' && (
              <p className="mb-2 text-xs text-amber-400">当前环境 MediaRecorder 不可用，无视频输出 — 请改选 GIF</p>
            )}
            {format === 'gif' && (
              <>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-xs text-[var(--tv-text-dim)]">抓帧</span>
                  <div className="flex gap-1">
                    {GIF_MODES.map((m) => (
                      <button
                        key={m.value}
                        data-rec-gifmode={m.value}
                        className={`rounded border px-2.5 py-1 text-xs ${
                          gifMode === m.value
                            ? 'border-sky-500 bg-sky-600/20 text-sky-300'
                            : 'border-[var(--tv-border2)] text-[var(--tv-text-dim)]'
                        }`}
                        onClick={() => setRecGifMode(m.value)}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="mb-2 text-xs text-[var(--tv-text-dim)]">
                  {gifMode === 'switch'
                    ? '切换抓帧：切图（导航/交换/换槽/显示源）自动抓一帧全分辨率画面（≤2560 宽，≤60 帧），按 C 手动补帧'
                    : '连续采样：高 15fps · ≤1280 宽（末尾 20 秒）；中 12fps · 720 宽（30 秒）；低 8fps · 480 宽（30 秒）'}
                </p>
                {gifMode === 'switch' && (
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-xs text-[var(--tv-text-dim)]">帧间时长（秒）</span>
                    <input
                      type="number"
                      min={0.1}
                      max={5}
                      step={0.1}
                      value={gifSec}
                      onChange={(e) => setRecGifFrameSec(Number(e.target.value))}
                      className="h-6 w-16 rounded border border-[var(--tv-border2)] bg-transparent px-1 text-center text-xs text-[var(--tv-text)]"
                      title="每帧在 GIF 中的停留时长 0.1–5 秒（编码时统一应用）"
                      data-rec-gifsec
                    />
                  </div>
                )}
              </>
            )}

            {qualityRow}

            {providerKind === 'browser' && (
              <p className="mb-3 text-[11px] text-[var(--tv-text-faint)]">浏览器模式：保存 = 触发下载（无法选择位置）</p>
            )}

            <div className="flex justify-end gap-2">
              <button
                data-rec-cancel
                className="rounded border border-[var(--tv-border2)] px-3 py-1.5 text-xs text-[var(--tv-text-dim)] hover:bg-[var(--tv-hover)]"
                onClick={cancelRecConfig}
              >
                取消
              </button>
              <button
                data-rec-start
                autoFocus
                className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500"
                onClick={confirmRecConfig}
              >
                开始录制
              </button>
            </div>
          </div>
        </div>
      )}

      {phase === 'starting' && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center">
          <div data-rec-pill className="flex items-center rounded-full bg-black/70 px-5 py-2.5 text-sm text-white shadow-lg">
            <span>{countdown}S 后开始录制</span>
            <span className="ml-3 inline-block w-6 text-center text-lg font-bold text-red-400">{countdown}</span>
            <span className="ml-2 text-xs text-neutral-300">再按 S 取消</span>
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
          {format === 'gif' && gifMode === 'switch' && <span data-rec-frame-count>· {frameCount} 帧</span>}
        </div>
      )}

      {phase === 'saving' && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50" data-rec-save>
          <div className="w-80 rounded-lg border border-[var(--tv-border2)] bg-[var(--tv-bg)] p-4 shadow-xl">
            <h3 className="mb-3 text-sm font-semibold text-[var(--tv-text)]">保存录制</h3>
            <p className="mb-3 text-xs text-[var(--tv-text-dim)]">
              按开录前选择保存：<span data-rec-save-params className="text-[var(--tv-text)]">{formatLabel} · 画质{qualityLabel}</span>
              {providerKind === 'electron' ? '（系统对话框选择保存位置）' : '（浏览器模式 = 触发下载）'}
            </p>
            <p className="mb-3 text-[11px] text-[var(--tv-text-faint)]">
              已取消保存或保存失败？可重试，或放弃本次录制。
            </p>
            <div className="flex justify-end gap-2">
              <button
                data-rec-discard
                className="rounded border border-[var(--tv-border2)] px-3 py-1.5 text-xs text-[var(--tv-text-dim)] hover:bg-[var(--tv-hover)]"
                onClick={cancelSave}
              >
                放弃录制
              </button>
              <button
                data-rec-save-ok
                className="rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
                onClick={() => void saveRecording()}
              >
                重试保存
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
