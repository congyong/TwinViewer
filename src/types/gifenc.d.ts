/** gifenc 无自带类型声明（dist 仅 JS），按实际使用面补齐 */
declare module 'gifenc' {
  export interface GifEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: {
        palette?: number[][]
        delay?: number
        transparent?: boolean
        transparentIndex?: number
        repeat?: number
        dispose?: number
      },
    ): void
    finish(): void
    bytes(): Uint8Array
  }
  export function GIFEncoder(opts?: { auto?: boolean }): GifEncoderInstance
  export function quantize(
    rgba: Uint8ClampedArray | number[],
    maxColors: number,
    opts?: { format?: string },
  ): number[][]
  export function applyPalette(
    rgba: Uint8ClampedArray | number[],
    palette: number[][],
    format?: string,
  ): Uint8Array
}
