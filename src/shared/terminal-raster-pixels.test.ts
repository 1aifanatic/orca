import { describe, expect, it } from 'vitest'
import { NodeTerminalRasterBackend } from './node-terminal-raster-backend'

const backend = new NodeTerminalRasterBackend()
function source() {
  return backend.fromRgba(
    new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
    2,
    2
  )
}

describe('terminal raster transforms', () => {
  it('crops exact pixels and pads out-of-bounds areas with transparency', () => {
    const input = source()
    expect(backend.crop(input, 1, 1, 1, 1).data).toEqual(
      new Uint8ClampedArray([255, 255, 255, 255])
    )
    const padded = backend.crop(input, -1, -1, 2, 2)
    expect([...padded.data]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 255])
    input.close()
    expect([...padded.data.subarray(12)]).toEqual([255, 0, 0, 255])
  })

  it('offsets and clips without modifying the source', () => {
    const input = source()
    const before = new Uint8ClampedArray(input.data)
    expect(backend.offset(input, -1, -1, 1, 1).data).toEqual(
      new Uint8ClampedArray([255, 255, 255, 255])
    )
    expect(backend.offset(input, 2, 0, 2, 2).data).toEqual(new Uint8ClampedArray(16))
    expect(input.data).toEqual(before)
  })

  it('interpolates colors using pixel centers and clamps source edges', () => {
    const resized = backend.resize(source(), 3, 3)
    expect([...resized.data.subarray(0, 4)]).toEqual([255, 0, 0, 255])
    expect([...resized.data.subarray(16, 20)]).toEqual([128, 128, 128, 255])
    expect([...resized.data.subarray(-4)]).toEqual([255, 255, 255, 255])
  })

  it('weights colors by coverage so invisible color does not bleed into visible edges', () => {
    const input = backend.fromRgba(new Uint8Array([255, 0, 0, 255, 0, 255, 0, 0]), 2, 1)
    const resized = backend.resize(input, 3, 1)
    expect([...resized.data]).toEqual([255, 0, 0, 255, 255, 0, 0, 128, 0, 0, 0, 0])
  })

  it('rejects released sources and oversized or fractional destinations', () => {
    const input = source()
    expect(() => backend.crop(input, 0.5, 0, 1, 1)).toThrow(RangeError)
    expect(() => backend.resize(input, 8_000_001, 1)).toThrow(RangeError)
    expect(() => backend.offset(input, Infinity, 0, 1, 1)).toThrow(RangeError)
    input.close()
    expect(() => backend.resize(input, 1, 1)).toThrow(RangeError)
    expect(() => backend.crop(input, 0, 0, 1, 1)).toThrow(RangeError)
  })
})
