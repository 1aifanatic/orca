import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import variants from './__fixtures__/terminal-raster-variants.json'
import { NodeTerminalRasterBackend } from './node-terminal-raster-backend'
import { releaseTerminalRasterDecoder } from './terminal-raster-wasm-decoder'

afterEach(releaseTerminalRasterDecoder)

describe('terminal codec pixel variants', () => {
  it('rotates a JPEG according to its EXIF orientation', () => {
    const backend = new NodeTerminalRasterBackend()
    const bytes = readFileSync(resolve('src/shared/__fixtures__/terminal-raster-oriented.jpg'))
    const raster = backend.decode(bytes, 'image/jpeg', 128)
    expect([raster.width, raster.height]).toEqual([8, 16])
    const top = (2 * raster.width + 4) * 4
    const bottom = (13 * raster.width + 4) * 4
    expect(raster.data[top]).toBeGreaterThan(240)
    expect(raster.data[top + 2]).toBeLessThan(15)
    expect(raster.data[bottom]).toBeLessThan(15)
    expect(raster.data[bottom + 2]).toBeGreaterThan(240)
    raster.close()
  })

  it.each(variants)('$name preserves decoded pixel values', (fixture) => {
    const backend = new NodeTerminalRasterBackend()
    const raster = backend.decode(
      Buffer.from(fixture.data, 'base64'),
      `image/${fixture.format}`,
      64
    )
    expect([raster.width, raster.height]).toEqual([fixture.width, fixture.height])
    if (fixture.tolerance) {
      for (let offset = 0; offset < fixture.pixels.length; offset += 4) {
        expect(
          Math.abs(raster.data[offset + 3]! - fixture.pixels[offset + 3]!)
        ).toBeLessThanOrEqual(1)
        for (let channel = 0; channel < 3; channel += 1) {
          const expected = (fixture.pixels[offset + channel]! * fixture.pixels[offset + 3]!) / 255
          const actual = (raster.data[offset + channel]! * raster.data[offset + 3]!) / 255
          expect(Math.abs(actual - expected)).toBeLessThanOrEqual(fixture.tolerance)
        }
      }
    } else {
      expect([...raster.data]).toEqual(fixture.pixels)
    }
    raster.close()
  })

  it('does not parse or retain later GIF animation frames', () => {
    const fixture = variants.find((variant) => variant.format === 'gif')
    if (!fixture) {
      throw new Error('Missing GIF fixture')
    }
    const bytes = Buffer.from(fixture.data, 'base64')
    // A still-frame decode must not interpret arbitrarily large later animation metadata.
    const expanded = Buffer.concat([bytes.subarray(0, -1), Buffer.alloc(1_000_000, 0x21)])
    const backend = new NodeTerminalRasterBackend()
    const raster = backend.decode(expanded, 'image/gif', 64)
    expect([...raster.data]).toEqual(fixture.pixels)
    raster.close()
  })
})
