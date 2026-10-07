import { afterEach, describe, expect, it } from 'vitest'
import { deflateSync } from 'node:zlib'
import fixtures from './__fixtures__/terminal-raster-red.json'
import { NodeTerminalRasterBackend } from './node-terminal-raster-backend'
import {
  getTerminalRasterDecoderState,
  releaseTerminalRasterDecoder
} from './terminal-raster-wasm-decoder'

afterEach(releaseTerminalRasterDecoder)

describe('production synchronous terminal codecs', () => {
  it.each(['png', 'jpeg', 'gif', 'webp', 'avif'] as const)(
    'decodes %s to owned pixels synchronously',
    (format) => {
      const backend = new NodeTerminalRasterBackend()
      const decoded = backend.decode(Buffer.from(fixtures[format], 'base64'), `image/${format}`, 64)
      expect(decoded).not.toBeInstanceOf(Promise)
      expect([decoded.width, decoded.height, decoded.data.length]).toEqual([8, 8, 256])
      expect(decoded.data[0]).toBeGreaterThanOrEqual(245)
      expect(decoded.data[1]).toBeLessThanOrEqual(10)
      expect(decoded.data[2]).toBeLessThanOrEqual(10)
      expect(decoded.data[3]).toBe(255)
      const beforeRelease = new Uint8ClampedArray(decoded.data)
      releaseTerminalRasterDecoder()
      expect(decoded.data).toEqual(beforeRelease)
      decoded.close()
      expect(decoded.data.length).toBe(0)
      decoded.close()
    }
  )

  it('shares one decoder across backend instances and replaces it on a format switch', () => {
    const first = new NodeTerminalRasterBackend()
    const second = new NodeTerminalRasterBackend()
    const png = first.decode(Buffer.from(fixtures.png, 'base64'), 'image/png', 64)
    const state = getTerminalRasterDecoderState()
    second.decode(Buffer.from(fixtures.png, 'base64'), 'image/png', 64).close()
    expect(getTerminalRasterDecoderState()).toEqual(state)
    second.decode(Buffer.from(fixtures.jpeg, 'base64'), 'image/jpeg', 64).close()
    expect(getTerminalRasterDecoderState().format).toBe('jpeg')
    expect(png.data.slice(0, 4)).toEqual(new Uint8ClampedArray([255, 0, 0, 255]))
    first.decode(Buffer.from(fixtures.png, 'base64'), 'image/png', 64).close()
    expect(getTerminalRasterDecoderState().format).toBe('png')
    png.close()
  })

  it.each(['png', 'jpeg', 'webp', 'avif'] as const)(
    'discards %s after decoder failure and recovers',
    (format) => {
      const backend = new NodeTerminalRasterBackend()
      const bytes = Buffer.from(fixtures[format], 'base64')
      backend.decode(bytes, `image/${format}`, 64).close()
      const truncated = bytes.subarray(0, format === 'png' ? 33 : format === 'jpeg' ? 710 : 50)
      expect(() => backend.decode(truncated, `image/${format}`, 64)).toThrow()
      // Header preflight failures need not touch the already-valid instance.
      if (format === 'png' || format === 'avif') {
        expect(getTerminalRasterDecoderState().memoryBytes).toBe(0)
      }
      backend.decode(bytes, `image/${format}`, 64).close()
      expect(getTerminalRasterDecoderState().format).toBe(format)
    }
  )

  it.each(['png', 'jpeg', 'gif', 'webp', 'avif'] as const)(
    'rejects %s above the caller pixel budget',
    (format) => {
      const backend = new NodeTerminalRasterBackend()
      expect(() =>
        backend.decode(Buffer.from(fixtures[format], 'base64'), `image/${format}`, 63)
      ).toThrow()
      expect(getTerminalRasterDecoderState().memoryBytes).toBe(0)
    }
  )

  it('bounds zlib inflation and leaves no partial result after exceeding the limit', () => {
    const backend = new NodeTerminalRasterBackend()
    const compressed = deflateSync(Buffer.alloc(4_096, 0xff))
    expect(() => backend.inflate(compressed, 4_095)).toThrow()
    expect(backend.inflate(compressed, 4_096)).toEqual(Buffer.alloc(4_096, 0xff))
    expect(() => backend.inflate(compressed, Infinity)).toThrow(RangeError)
    expect(() => backend.inflate(compressed, 32_000_001)).toThrow(RangeError)
  })

  it('copies pooled RGBA input and rejects invalid pixel storage before copying', () => {
    const backend = new NodeTerminalRasterBackend()
    const data = new Uint8Array([255, 0, 0, 255])
    const raster = backend.fromRgba(data, 1, 1)
    data.fill(0)
    expect(raster.data).toEqual(new Uint8ClampedArray([255, 0, 0, 255]))
    expect(() => backend.fromRgba(data, 8_000_001, 1)).toThrow(RangeError)
    expect(() => backend.fromRgba(data, 1, 2)).toThrow(RangeError)
    expect(() => backend.decode(data, 'image/svg+xml', 1)).toThrow()
    raster.close()
  })
})
