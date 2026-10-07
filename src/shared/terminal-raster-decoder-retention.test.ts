import { afterEach, describe, expect, it } from 'vitest'
import { initSync } from '@jsquash/png/codec/pkg/squoosh_png'
import assets from './terminal-raster-codec-assets.json'
import fixtures from './__fixtures__/terminal-raster-red.json'
import { NodeTerminalRasterBackend } from './node-terminal-raster-backend'
import { releaseTerminalRasterDecoder } from './terminal-raster-wasm-decoder'

afterEach(releaseTerminalRasterDecoder)

async function collect(): Promise<void> {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

function pngMemory(): WeakRef<WebAssembly.Memory> {
  const module = new WebAssembly.Module(Buffer.from(assets.decoders.png.data, 'base64'))
  return new WeakRef(initSync(module).memory)
}

describe('terminal PNG decoder root retention', () => {
  it.each(['release', 'format switch', 'failure'] as const)(
    'releases the old PNG memory after %s while returned pixels survive',
    async (action) => {
      const backend = new NodeTerminalRasterBackend()
      const bytes = Buffer.from(fixtures.png, 'base64')
      const raster = backend.decode(bytes, 'image/png', 64)
      const ref = pngMemory()
      expect(ref.deref()).toBeDefined()
      if (action === 'release') {
        releaseTerminalRasterDecoder()
      } else if (action === 'format switch') {
        backend.decode(Buffer.from(fixtures.jpeg, 'base64'), 'image/jpeg', 64).close()
      } else {
        expect(() => backend.decode(bytes.subarray(0, 33), 'image/png', 64)).toThrow()
      }
      await collect()
      expect(ref.deref()).toBeUndefined()
      expect(raster.data.slice(0, 4)).toEqual(new Uint8ClampedArray([255, 0, 0, 255]))
      backend.decode(bytes, 'image/png', 64).close()
      raster.close()
    }
  )
})
