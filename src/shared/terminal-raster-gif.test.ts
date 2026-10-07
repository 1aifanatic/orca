import { describe, expect, it } from 'vitest'
import { GifReader, GifWriter } from 'omggif'
import { decodeTerminalGif } from './terminal-raster-gif'
import { NodeTerminalRasterBackend } from './node-terminal-raster-backend'

const palette = [255, 0, 0, 0, 255, 0]

function gif(width: number, height: number, codes: number[], interlaced = false): Uint8Array {
  const stream: number[] = []
  let pending = 0
  let bits = 0
  for (const code of codes) {
    pending |= code << bits
    bits += 3
    while (bits >= 8) {
      stream.push(pending & 255)
      pending >>= 8
      bits -= 8
    }
  }
  if (bits) {
    stream.push(pending & 255)
  }
  return new Uint8Array([
    ...Buffer.from('GIF89a'),
    width,
    0,
    height,
    0,
    128,
    0,
    0,
    ...palette,
    0x2c,
    0,
    0,
    0,
    0,
    width,
    0,
    height,
    0,
    interlaced ? 64 : 0,
    2,
    stream.length,
    ...stream,
    0,
    0x3b
  ])
}

describe('bounded first-frame GIF decoding', () => {
  it.each([
    ['too few pixels', 2, [4, 0, 5]],
    ['too many pixels', 1, [4, 0, 1, 5]],
    ['undefined first dictionary code', 1, [4, 6, 5]],
    ['undefined dictionary code after a pixel', 2, [4, 0, 7, 5]],
    ['stale dictionary code after clearing', 3, [4, 0, 1, 4, 6, 5]],
    ['pixel index outside the color table', 1, [4, 2, 5]]
  ] as const)('rejects %s instead of returning partial pixels', (_name, width, codes) => {
    const bytes = gif(width, 1, [...codes])
    const backend = new NodeTerminalRasterBackend()
    expect(() => backend.decode(bytes, 'image/gif', width)).toThrow()
    const reader = new GifReader(bytes)
    expect(() => reader.decodeAndBlitFrameBGRA(0, new Uint8Array(width * 4))).toThrow()
    const valid = backend.decode(gif(1, 1, [4, 0, 5]), 'image/gif', 1)
    expect([...valid.data]).toEqual([255, 0, 0, 255])
    valid.close()
  })

  it('accepts dictionary expansion that refers to the next code', () => {
    const raster = decodeTerminalGif(gif(3, 1, [4, 0, 6, 5]))
    expect([...raster.data]).toEqual([...palette.slice(0, 3), 255, 255, 0, 0, 255, 255, 0, 0, 255])
  })

  it('accepts a stream without an initial clear code', () => {
    expect([...decodeTerminalGif(gif(1, 1, [0, 5])).data]).toEqual([255, 0, 0, 255])
  })

  it('accepts a complete frame without a readable end code', () => {
    expect([...decodeTerminalGif(gif(1, 1, [4, 0])).data]).toEqual([255, 0, 0, 255])
  })

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('reconstructs interlace passes at height %i', (height) => {
    const rows = [0, 8, 4, 2, 6, 1, 3, 5, 7].filter((row) => row < height)
    const codes = [...rows.flatMap((row) => [4, row % 2]), 5]
    const bytes = gif(1, height, codes, true)
    const raster = decodeTerminalGif(bytes)
    expect([...raster.data]).toEqual(
      Array.from({ length: height }, (_, row) => [
        ...palette.slice((row % 2) * 3, (row % 2) * 3 + 3),
        255
      ]).flat()
    )
    const bgra = new Uint8Array(height * 4)
    new GifReader(bytes).decodeAndBlitFrameBGRA(0, bgra)
    expect([...bgra]).toEqual(
      Array.from({ length: height }, (_, row) => {
        const offset = (row % 2) * 3
        return [palette[offset + 2], palette[offset + 1], palette[offset], 255]
      }).flat()
    )
  })

  it('preserves pixels as dictionary entries grow and reset across subblocks', () => {
    const width = 512
    const height = 128
    let state = 47
    const indices = Array.from({ length: width * height }, () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state >>> 24
    })
    const buffer = new Uint8Array(indices.length * 2)
    const writer = new GifWriter(buffer, width, height, {
      palette: Array.from({ length: 256 }, (_, value) => value * 0x010101)
    })
    writer.addFrame(0, 0, width, height, indices)
    const raster = decodeTerminalGif(buffer.subarray(0, writer.end()))
    expect([...raster.data]).toEqual(indices.flatMap((value) => [value, value, value, 255]))
  })
})
