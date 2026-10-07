import { describe, expect, it } from 'vitest'
import { boundCodecMemory } from './terminal-raster-codec-memory.mjs'

const header = [0, 97, 115, 109, 1, 0, 0, 0]
const memoryExport = [7, 10, 1, 6, 109, 101, 109, 111, 114, 121, 2, 0]
function moduleBytes(limits) {
  return Buffer.from([...header, 5, limits.length + 1, 1, ...limits, ...memoryExport])
}

describe('bounded terminal codec WASM', () => {
  it('enforces the maximum on actual memory growth without mutating the input', () => {
    const original = moduleBytes([0, 1])
    const preserved = Buffer.from(original)
    const bounded = boundCodecMemory(original, 2 * 65_536)
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bounded))
    const memory = instance.exports.memory
    expect(memory).toBeInstanceOf(WebAssembly.Memory)
    expect(memory.grow(1)).toBe(1)
    expect(() => memory.grow(1)).toThrow(RangeError)
    expect(memory.buffer.byteLength).toBe(2 * 65_536)
    expect(original).toEqual(preserved)
  })

  it('preserves an upstream maximum smaller than the requested budget', () => {
    const bounded = boundCodecMemory(moduleBytes([1, 1, 2]), 3 * 65_536)
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bounded))
    expect(instance.exports.memory.grow(1)).toBe(1)
    expect(() => instance.exports.memory.grow(1)).toThrow(RangeError)
  })

  it.each([0, -1, 65_535, 65_537, Number.NaN, Infinity])('rejects invalid limits: %s', (limit) => {
    expect(() => boundCodecMemory(moduleBytes([0, 1]), limit)).toThrow(RangeError)
  })

  it.each([
    [],
    [...header, 5, 3, 1, 0],
    [...header, 5, 128],
    [...header, 5, 255, 255, 255, 255, 31],
    [...header, 5, 3, 1, 0, 1, 5, 3, 1, 0, 1],
    [...header, 5, 5, 2, 0, 1, 0, 1],
    [...header, 5, 4, 1, 3, 1, 2],
    [...header, 5, 3, 1, 0, 3, ...memoryExport],
    [...header, 5, 3, 1, 0, 1],
    [...header, 2, 9, 1, 1, 109, 1, 109, 2, 0, 1]
  ])('rejects truncated, duplicate, unowned or unsupported memory layouts %#', (bytes) => {
    expect(() => boundCodecMemory(Buffer.from(bytes), 2 * 65_536)).toThrow()
  })
})
