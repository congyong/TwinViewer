/**
 * BIFant（盒式面积平均）重采样独立验证：
 * 合成图（对角平滑渐变 + 细网格纹理）分别在 50% / 78% / 100% / 150% 目标尺寸跑 resamplePixels，
 * 对渐变输出做平滑度断言（相邻行/列均值差无周期性尖峰）+ 能量守恒断言（全局均值）。
 * 用法：先 tsc 编译 resampler.ts 到 .verify-tmp（见 package.json scripts.verify-bifant），再 node 本脚本。
 * 退出码：0 全过；1 有断言失败。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { resamplePixels } from '../.verify-tmp/resampler.js'

const SW = 96
const SH = 96

/** 对角平滑渐变 0..255（常数沿反对角线，行列均值均线性） */
function makeGradient() {
  const d = new Uint8ClampedArray(SW * SH * 4)
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const v = Math.round((255 * (x + y)) / (SW + SH - 2))
      const o = (y * SW + x) * 4
      d[o] = d[o + 1] = d[o + 2] = v
      d[o + 3] = 255
    }
  }
  return d
}

/** 细网格纹理：2px 周期棋盘 64/192（高频细节，供目视 PNG 检查） */
function makeGrid() {
  const d = new Uint8ClampedArray(SW * SH * 4)
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const v = ((x >> 1) + (y >> 1)) % 2 === 0 ? 64 : 192
      const o = (y * SW + x) * 4
      d[o] = d[o + 1] = d[o + 2] = v
      d[o + 3] = 255
    }
  }
  return d
}

/** 灰度 RGBA → PGM (P5) 字节 */
function toPgm(d, w, h) {
  const head = Buffer.from(`P5\n${w} ${h}\n255\n`, 'ascii')
  const body = Buffer.alloc(w * h)
  for (let i = 0; i < w * h; i++) body[i] = d[i * 4]
  return Buffer.concat([head, body])
}

/** 列均值剖面（灰度） */
function colMeans(d, w, h) {
  const out = new Float64Array(w)
  for (let x = 0; x < w; x++) {
    let s = 0
    for (let y = 0; y < h; y++) s += d[(y * w + x) * 4]
    out[x] = s / h
  }
  return out
}
/** 行均值剖面 */
function rowMeans(d, w, h) {
  const out = new Float64Array(h)
  for (let y = 0; y < h; y++) {
    let s = 0
    for (let x = 0; x < w; x++) s += d[(y * w + x) * 4]
    out[y] = s / w
  }
  return out
}

/** 平滑度：相邻差绝对值的最大值 / 中位数比（周期尖峰 → 比值显著 >2） */
function spikeRatio(profile) {
  const deltas = []
  for (let i = 1; i < profile.length; i++) deltas.push(Math.abs(profile[i] - profile[i - 1]))
  deltas.sort((a, b) => a - b)
  const median = deltas[Math.floor(deltas.length / 2)] || 1e-9
  const max = deltas[deltas.length - 1]
  return { max, median, ratio: max / Math.max(median, 1e-9) }
}

function globalMean(d) {
  let s = 0
  for (let i = 0; i < d.length; i += 4) s += d[i]
  return s / (d.length / 4)
}

mkdirSync(new URL('../.verify-tmp', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), { recursive: true })
const outDir = new URL('../.verify-tmp/', import.meta.url)

const grad = makeGradient()
const grid = makeGrid()
const gradMean = globalMean(grad)

const cases = [
  { pct: 50, tw: 48, th: 48 },
  { pct: 78, tw: 75, th: 75 },
  { pct: 100, tw: 96, th: 96 },
  { pct: 150, tw: 144, th: 144 },
]

let fail = 0
const results = []
for (const c of cases) {
  const out = resamplePixels(grad, SW, SH, c.tw, c.th, 'bifant')
  const outGrid = resamplePixels(grid, SW, SH, c.tw, c.th, 'bifant')
  writeFileSync(new URL(`bifant-grad-${c.pct}.pgm`, outDir), toPgm(out, c.tw, c.th))
  writeFileSync(new URL(`bifant-grid-${c.pct}.pgm`, outDir), toPgm(outGrid, c.tw, c.th))

  const col = spikeRatio(colMeans(out, c.tw, c.th))
  const row = spikeRatio(rowMeans(out, c.tw, c.th))
  const mean = globalMean(out)
  const meanErr = Math.abs(mean - gradMean)
  // 断言：尖峰比 ≤ 2.5（平滑渐变无周期线）；全局均值漂移 ≤ 1.0 灰级（能量守恒）
  const ok = col.ratio <= 2.5 && row.ratio <= 2.5 && meanErr <= 1.0
  if (!ok) fail++
  results.push({
    pct: `${c.pct}%`,
    size: `${c.tw}x${c.th}`,
    colRatio: +col.ratio.toFixed(2),
    rowRatio: +row.ratio.toFixed(2),
    colMax: +col.max.toFixed(2),
    meanErr: +meanErr.toFixed(3),
    ok,
  })
}
console.log(JSON.stringify({ results, fail }, null, 1))
if (fail > 0) {
  console.error(`[VERIFY-BIFANT] ${fail} 个尺寸断言失败（存在周期性横竖线/能量漂移）`)
  process.exit(1)
}
console.log('[VERIFY-BIFANT] 全部通过（50/78/100/150% 平滑度与能量守恒达标）')
