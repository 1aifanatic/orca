import type { IImageRaster } from '@xterm/addon-image/src/ImageRasterBackend'

export const TERMINAL_RASTER_PIXEL_LIMIT = 8_000_000

export function checkTerminalRasterSize(width: number, height: number, pixelLimit: number): void {
  if (
    !Number.isSafeInteger(pixelLimit) ||
    pixelLimit <= 0 ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > Math.min(pixelLimit, TERMINAL_RASTER_PIXEL_LIMIT)
  ) {
    throw new RangeError('Invalid terminal raster size')
  }
}

export class TerminalRasterPixels implements IImageRaster {
  readonly kind = 'rgba' as const

  constructor(
    public data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number
  ) {
    checkTerminalRasterSize(width, height, TERMINAL_RASTER_PIXEL_LIMIT)
    if (data.byteLength !== width * height * 4) {
      throw new RangeError('Invalid terminal raster pixels')
    }
  }

  close(): void {
    this.data = new Uint8ClampedArray(0)
  }
}

function checkSource(source: IImageRaster): void {
  checkTerminalRasterSize(source.width, source.height, TERMINAL_RASTER_PIXEL_LIMIT)
  if (source.kind !== 'rgba' || source.data.byteLength !== source.width * source.height * 4) {
    throw new RangeError('Invalid or released terminal raster')
  }
}

export function translateTerminalRaster(
  source: IImageRaster,
  x: number,
  y: number,
  width: number,
  height: number
): TerminalRasterPixels {
  checkSource(source)
  checkTerminalRasterSize(width, height, TERMINAL_RASTER_PIXEL_LIMIT)
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    throw new RangeError('Invalid terminal raster offset')
  }
  const pixels = new Uint8ClampedArray(width * height * 4)
  const startX = Math.max(0, x)
  const endX = Math.min(width, x + source.width)
  const startY = Math.max(0, y)
  const endY = Math.min(height, y + source.height)
  if (endX > startX) {
    for (let row = startY; row < endY; row += 1) {
      const sourceStart = ((row - y) * source.width + startX - x) * 4
      pixels.set(
        source.data.subarray(sourceStart, sourceStart + (endX - startX) * 4),
        (row * width + startX) * 4
      )
    }
  }
  return new TerminalRasterPixels(pixels, width, height)
}

export function resizeTerminalRaster(
  source: IImageRaster,
  width: number,
  height: number
): TerminalRasterPixels {
  checkSource(source)
  checkTerminalRasterSize(width, height, TERMINAL_RASTER_PIXEL_LIMIT)
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let row = 0; row < height; row += 1) {
    const sourceY = Math.max(
      0,
      Math.min(source.height - 1, ((row + 0.5) * source.height) / height - 0.5)
    )
    const top = Math.floor(sourceY)
    const bottom = Math.min(source.height - 1, top + 1)
    const vertical = sourceY - top
    for (let column = 0; column < width; column += 1) {
      const sourceX = Math.max(
        0,
        Math.min(source.width - 1, ((column + 0.5) * source.width) / width - 0.5)
      )
      const left = Math.floor(sourceX)
      const right = Math.min(source.width - 1, left + 1)
      const horizontal = sourceX - left
      const topLeft = (top * source.width + left) * 4
      const topRight = (top * source.width + right) * 4
      const bottomLeft = (bottom * source.width + left) * 4
      const bottomRight = (bottom * source.width + right) * 4
      const a = source.data[topLeft + 3]! * (1 - horizontal) * (1 - vertical)
      const b = source.data[topRight + 3]! * horizontal * (1 - vertical)
      const c = source.data[bottomLeft + 3]! * (1 - horizontal) * vertical
      const d = source.data[bottomRight + 3]! * horizontal * vertical
      const alpha = a + b + c + d
      const target = (row * width + column) * 4
      pixels[target + 3] = Math.round(alpha)
      if (pixels[target + 3] > 0) {
        for (let channel = 0; channel < 3; channel += 1) {
          pixels[target + channel] = Math.round(
            (source.data[topLeft + channel]! * a +
              source.data[topRight + channel]! * b +
              source.data[bottomLeft + channel]! * c +
              source.data[bottomRight + channel]! * d) /
              alpha
          )
        }
      }
    }
  }
  return new TerminalRasterPixels(pixels, width, height)
}
