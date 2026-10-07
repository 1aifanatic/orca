import { PNG } from 'pngjs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeTerminalRasterBackend } from './node-terminal-raster-backend'
import {
  getTerminalRasterDecoderState,
  releaseTerminalRasterDecoder
} from './terminal-raster-wasm-decoder'
import fixtures from './__fixtures__/terminal-raster-red.json'

afterEach(releaseTerminalRasterDecoder)

describe('terminal raster large-image working memory', () => {
  it('keeps a streaming PNG decoder within the retained heap budget', () => {
    const png = new PNG({ width: 2_048, height: 2_048 })
    png.data.fill(255)
    const bytes = PNG.sync.write(png)
    const backend = new NodeTerminalRasterBackend()
    const raster = backend.decode(bytes, 'image/png', 8_000_000)
    expect([raster.width, raster.height, raster.data.length]).toEqual([2_048, 2_048, 16_777_216])
    expect([...raster.data.subarray(-4)]).toEqual([255, 255, 255, 255])
    expect(getTerminalRasterDecoderState().memoryBytes).toBeGreaterThan(0)
    expect(getTerminalRasterDecoderState().memoryBytes).toBeLessThan(32 * 1024 * 1024)
    backend.decode(Buffer.from(fixtures.png, 'base64'), 'image/png', 64).close()
    expect(getTerminalRasterDecoderState().memoryBytes).toBeLessThan(32 * 1024 * 1024)
    expect([...raster.data.subarray(0, 4)]).toEqual([255, 255, 255, 255])
    raster.close()
  })

  it('discards a progressive JPEG working heap above the retained budget after copying its pixels', () => {
    const bytes = readFileSync(resolve('src/shared/__fixtures__/terminal-raster-large.jpg'))
    const backend = new NodeTerminalRasterBackend()
    const raster = backend.decode(bytes, 'image/jpeg', 8_000_000)
    expect([raster.width, raster.height, raster.data.length]).toEqual([3_999, 2_000, 31_992_000])
    expect(getTerminalRasterDecoderState().memoryBytes).toBe(0)
    expect([...raster.data.subarray(-4)]).toEqual([255, 255, 255, 255])
    backend.decode(Buffer.from(fixtures.jpeg, 'base64'), 'image/jpeg', 64).close()
    expect(getTerminalRasterDecoderState().format).toBe('jpeg')
    expect([...raster.data.subarray(0, 4)]).toEqual([255, 255, 255, 255])
    raster.close()
  })
})
