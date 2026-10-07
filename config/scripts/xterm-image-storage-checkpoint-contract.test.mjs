import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixtures from '../../src/shared/__fixtures__/terminal-raster-red.json'
import { NodeTerminalRasterBackend } from '../../src/shared/node-terminal-raster-backend'
import { releaseTerminalRasterDecoder } from '../../src/shared/terminal-raster-wasm-decoder'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless')
const { ImageAddon } = require('@xterm/addon-image')
const { SerializeAddon } = require('@xterm/addon-serialize')
afterEach(releaseTerminalRasterDecoder)

function terminal() {
  const core = new Terminal({
    cols: 20,
    rows: 10,
    scrollback: 20,
    allowProposedApi: true,
    logLevel: 'off'
  })
  const backend = new NodeTerminalRasterBackend({
    getCellSize: () => ({ width: 2, height: 2 }),
    getColors: () => ({
      foreground: { rgba: 0xffffffff },
      background: { rgba: 0x000000ff },
      ansi: []
    })
  })
  const addon = new ImageAddon({
    rasterBackend: backend,
    pixelLimit: 8_000_000,
    storageLimit: 32,
    enableSizeReports: false,
    kittySizeLimit: 8 * 1024 * 1024,
    iipSizeLimit: 8 * 1024 * 1024,
    sixelSizeLimit: 8 * 1024 * 1024
  })
  const serializer = new SerializeAddon()
  core.loadAddon(addon)
  core.loadAddon(serializer)
  return { core, addon, backend, serializer, storage: addon._storage }
}

const raw = Buffer.from(Array.from({ length: 64 }, (_, i) => [255, i % 2 ? 0 : 100, 0, 255]).flat())
const kitty = (command, bytes = raw) => `\x1b_G${command};${bytes.toString('base64')}\x1b\\`
const protocols = [
  ['Kitty', kitty('a=T,f=32,s=8,v=8,i=7,q=2')],
  ['IIP', `\x1b]1337;File=inline=1;width=8px;height=8px:${fixtures.png}\x07`],
  ['SIXEL', '\x1bPq"1;1;8;6#0;2;100;0;0#0!8~\x1b\\']
]

function cells(h, type) {
  const buffer = type === 'normal' ? h.core._core.buffers.normal : h.core._core.buffers.alt
  return Array.from({ length: buffer.lines.length }, (_, row) => {
    const line = buffer.lines.get(row)
    return Array.from({ length: line.length }, (_, col) => {
      // Text overwrites can leave ignored attribute objects behind.
      const attrs = line.getBg(col) & 0x10000000 ? line._extendedAttrs[col] : undefined
      return [attrs?.imageId ?? -1, attrs?.tileId ?? -1]
    })
  })
}

describe('decoded image storage checkpoint component', () => {
  it('restores a source larger than the resource chunk limit through bounded reads', async () => {
    const source = terminal()
    const target = terminal()
    let checkpoint
    try {
      const pixels = new Uint8Array(512 * 256 * 4).fill(255)
      pixels[0] = 123
      pixels[pixels.length - 1] = 99
      source.storage.addUnplacedImage(source.backend.fromRgba(pixels, 512, 256), {
        layer: 'top',
        zIndex: 0
      })
      checkpoint = source.storage.captureCheckpoint(pixels.length)
      const read = vi.spyOn(checkpoint, 'readResource')
      source.addon.reset()
      await target.storage.restoreCheckpoint(checkpoint)
      expect(read.mock.calls.map(([, offset, length]) => [offset, length])).toEqual([
        [0, 262144],
        [262144, 262144]
      ])
      expect([...target.storage._images.values()][0].orig.data).toEqual(
        new Uint8ClampedArray(pixels)
      )
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each(protocols)(
    '%s survives source reset without replaying the image',
    async (_name, sequence) => {
      const source = terminal()
      const target = terminal()
      let checkpoint
      try {
        source.core._core.writeSync(`BEFORE${sequence}AFTER`)
        const ansi = source.serializer.serialize()
        const expectedCells = cells(source, 'normal')
        const pixels = new Uint8ClampedArray([...source.storage._images.values()][0].orig.data)
        checkpoint = source.storage.captureCheckpoint(1024 * 1024)
        source.addon.reset()
        target.core._core.writeSync(ansi)
        const cursor = [target.core.buffer.active.cursorX, target.core.buffer.active.cursorY]
        const reply = vi.fn()
        target.core.onData(reply)
        await target.storage.restoreCheckpoint(checkpoint)
        expect(cells(target, 'normal')).toEqual(expectedCells)
        expect([...target.storage._images.values()][0].orig.data).toEqual(pixels)
        expect([target.core.buffer.active.cursorX, target.core.buffer.active.cursorY]).toEqual(
          cursor
        )
        expect(reply).not.toHaveBeenCalled()
      } finally {
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it('captures normal and alternate placements, large internal IDs and virtual prototypes', async () => {
    const source = terminal()
    const target = terminal()
    let checkpoint
    try {
      source.storage._lastId = 2 ** 32
      source.core._core.writeSync(kitty('a=T,f=32,s=8,v=8,i=7,q=2'))
      source.core._core.writeSync(kitty('a=T,f=32,s=8,v=8,i=8,U=1,c=4,r=4,q=2'))
      source.core._core.writeSync('\x1b[?1049h')
      source.core._core.writeSync(kitty('a=T,f=32,s=8,v=8,i=9,q=2'))
      const expected = ['normal', 'alternate'].map((type) => cells(source, type))
      const ansi = source.serializer.serialize()
      checkpoint = source.storage.captureCheckpoint(1024 * 1024)
      expect(checkpoint.metadata.images.map((image) => image.id)).toEqual([
        2 ** 32 + 1,
        2 ** 32 + 2,
        2 ** 32 + 3
      ])
      expect(checkpoint.metadata.images.find((image) => image.virtual).kittyId).toBe(8)
      target.core._core.writeSync(ansi)
      await target.storage.restoreCheckpoint(checkpoint)
      expect(['normal', 'alternate'].map((type) => cells(target, type))).toEqual(expected)
      expect(target.storage._lastId).toBe(2 ** 32 + 3)
      expect([...target.storage._images.values()].map((image) => image.bufferType)).toEqual([
        'normal',
        'normal',
        'alternate'
      ])
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('owns bounded chunk copies and immutable metadata until explicitly released', () => {
    const h = terminal()
    let checkpoint
    try {
      h.core._core.writeSync(kitty('a=T,f=32,s=8,v=8,i=7,q=2'))
      checkpoint = h.storage.captureCheckpoint(1024 * 1024)
      const resource = checkpoint.metadata.resources.find(
        (entry) => entry.id === checkpoint.metadata.images[0].resourceId
      )
      const copy = checkpoint.readResource(resource.id, 0, resource.byteLength)
      copy.fill(0)
      h.core.dispose()
      expect(checkpoint.readResource(resource.id, 0, resource.byteLength)).toEqual(
        new Uint8Array(raw)
      )
      expect(Object.isFrozen(checkpoint.metadata.images[0])).toBe(true)
      expect(Object.isFrozen(checkpoint.metadata.resources)).toBe(true)
      expect(() => checkpoint.readResource(resource.id, 0, 262145)).toThrow()
      expect(() => checkpoint.readResource(resource.id, -1, 1)).toThrow()
      checkpoint.dispose()
      checkpoint.dispose()
      expect(() => checkpoint.readResource(resource.id, 0, 1)).toThrow()
    } finally {
      checkpoint?.dispose()
      h.core.dispose()
    }
  })

  it('rejects an undersized lease without changing image ownership or cells', () => {
    const h = terminal()
    try {
      h.core._core.writeSync(kitty('a=T,f=32,s=8,v=8,i=7,q=2'))
      const original = [...h.storage._images.values()][0].orig
      const expected = cells(h, 'normal')
      expect(() => h.storage.captureCheckpoint(255)).toThrow(/budget/i)
      expect(original.data.byteLength).toBe(256)
      expect(cells(h, 'normal')).toEqual(expected)
    } finally {
      h.core.dispose()
    }
  })
})
