/**
 * Windows 资源管理器风格文件夹图标（SVG 自绘）：
 * - FolderIcon：完整填充版（无预览图时、列表行、文件夹树）
 * - FolderFrame：框架版——标签实心 + 主体仅描边（透明底），叠加在拼贴预览上，
 *   使预览图「嵌在」文件夹主体区域内（viewBox 64×56，主体区约 x:4..60, y:18..51）
 * 配色暖黄 + 深棕描边，与图片缩略图明显区分；暗 / 亮主题下均清晰。
 */

const BACK_FILL = '#E3A008'
const FRONT_FILL = '#F7C85C'
const STROKE = '#92400E'

/** 完整填充文件夹 */
export function FolderIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 56" className={className} aria-hidden="true">
      {/* 背板（含左上标签页） */}
      <path
        d="M7 17 V11 Q7 7 11 7 H23 Q26 7 28 9.5 L31 13 H53 Q57 13 57 17 V44 Q57 48 53 48 H11 Q7 48 7 44 Z"
        fill={BACK_FILL}
        stroke={STROKE}
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {/* 前板（微透视，底部略窄） */}
      <path
        d="M4 22 Q4 18 8 18 H56 Q60 18 60 22 L57.5 46 Q57 50 53 50 H11 Q7 50 6.5 46 Z"
        fill={FRONT_FILL}
        stroke={STROKE}
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 框架版：标签实心 + 主体透明仅描边（叠加在拼贴预览上） */
export function FolderFrame({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 56" className={className} aria-hidden="true">
      {/* 标签页（实心） */}
      <path
        d="M7 18 V11 Q7 7 11 7 H23 Q26 7 28 9.5 L31 13 H53 Q57 13 57 17 V18 Z"
        fill={BACK_FILL}
        stroke={STROKE}
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {/* 主体边框（透明底，预览图透出） */}
      <path
        d="M4 22 Q4 18 8 18 H56 Q60 18 60 22 L57.5 46 Q57 50 53 50 H11 Q7 50 6.5 46 Z"
        fill="none"
        stroke={STROKE}
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}
