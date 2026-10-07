import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import jpegFactory from '@jsquash/jpeg/codec/dec/mozjpeg_dec.js'
import webpFactory from '@jsquash/webp/codec/dec/webp_dec.js'
import avifFactory from '@jsquash/avif/codec/dec/avif_dec.js'
import { initSync, releaseDecoder } from '@jsquash/png/codec/pkg/squoosh_png.js'
import assets from '../../src/shared/terminal-raster-codec-assets.json'
import { boundCodecMemory } from './terminal-raster-codec-memory.mjs'

const require = createRequire(import.meta.url)
afterEach(releaseDecoder)
const sources = [
  ['png', '@jsquash/png/codec/pkg/squoosh_png_bg.wasm', null],
  ['jpeg', '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm', jpegFactory],
  ['webp', '@jsquash/webp/codec/dec/webp_dec.wasm', webpFactory],
  ['avif', '@jsquash/avif/codec/dec/avif_dec.wasm', avifFactory]
]

describe('shipped bounded terminal decoder assets', () => {
  it.each(sources)(
    '%s matches its pinned source and enforces its actual memory ceiling',
    async (format, path, factory) => {
      const asset = assets.decoders[format]
      const original = readFileSync(require.resolve(path))
      const binary = Buffer.from(asset.data, 'base64')
      expect(createHash('sha256').update(original).digest('hex')).toBe(asset.sourceSha256)
      expect(createHash('sha256').update(binary).digest('hex')).toBe(asset.sha256)
      expect(binary.byteLength).toBe(asset.bytes)
      expect(binary).toEqual(boundCodecMemory(original, assets.maximumBytes))
      const module = new WebAssembly.Module(binary)
      let memory
      if (format === 'png') {
        memory = initSync(module).memory
      } else {
        await factory({
          noInitialRun: true,
          instantiateWasm(imports, callback) {
            const instance = new WebAssembly.Instance(module, imports)
            memory = Object.values(instance.exports).find(
              (value) => value instanceof WebAssembly.Memory
            )
            callback(instance)
            return instance.exports
          }
        })
      }
      expect(memory).toBeInstanceOf(WebAssembly.Memory)
      const remainingPages = (assets.maximumBytes - memory.buffer.byteLength) / 65_536
      expect(() => memory.grow(remainingPages + 1)).toThrow(RangeError)
      memory.grow(remainingPages)
      expect(memory.buffer.byteLength).toBe(assets.maximumBytes)
      expect(() => memory.grow(1)).toThrow(RangeError)
    }
  )
})
