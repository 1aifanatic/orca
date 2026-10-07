import { GifReader } from 'omggif'
import { checkTerminalRasterSize, TERMINAL_RASTER_PIXEL_LIMIT } from './terminal-raster-pixels'

// Parse only the still frame; later animation metadata must not grow the decoder's frame array.
function firstFrameBytes(data: Uint8Array): Uint8Array {
  let offset = 13
  function take(length: number): number {
    const start = offset
    offset += length
    if (offset > data.byteLength) {
      throw new Error('Truncated terminal GIF')
    }
    return start
  }
  function subblocks(): void {
    let length = data[take(1)]!
    while (length > 0) {
      take(length)
      length = data[take(1)]!
    }
  }
  if (data.byteLength < offset) {
    throw new Error('Truncated terminal GIF header')
  }
  if (data[10]! & 128) {
    take(3 * (1 << ((data[10]! & 7) + 1)))
  }
  while (offset < data.byteLength) {
    const marker = data[take(1)]
    if (marker === 0x21) {
      take(1)
      subblocks()
    } else if (marker === 0x2c) {
      const descriptor = take(9)
      const packed = data[descriptor + 8]!
      if (packed & 128) {
        take(3 * (1 << ((packed & 7) + 1)))
      }
      const codeSize = data[take(1)]!
      if (codeSize < 2 || codeSize > 8) {
        throw new Error('Invalid terminal GIF code size')
      }
      subblocks()
      return data.subarray(0, offset)
    } else {
      throw new Error('Terminal GIF has no valid first frame')
    }
  }
  throw new Error('Terminal GIF has no image frame')
}

export function decodeTerminalGif(data: Uint8Array): {
  width: number
  height: number
  data: Uint8ClampedArray
} {
  const reader = new GifReader(firstFrameBytes(data))
  checkTerminalRasterSize(reader.width, reader.height, TERMINAL_RASTER_PIXEL_LIMIT)
  const frame = reader.frameInfo(0)
  if (
    frame.width <= 0 ||
    frame.height <= 0 ||
    frame.x + frame.width > reader.width ||
    frame.y + frame.height > reader.height ||
    frame.palette_offset === null ||
    frame.palette_size === null
  ) {
    throw new Error('Invalid terminal GIF frame')
  }
  const pixels = new Uint8ClampedArray(reader.width * reader.height * 4)
  reader.decodeAndBlitFrameRGBA(0, pixels)
  return { width: reader.width, height: reader.height, data: pixels }
}
