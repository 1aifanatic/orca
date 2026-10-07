import { createRequire } from 'node:module'
import { inflateRawSync, inflateSync, deflateSync } from 'node:zlib'
import { PNG } from 'pngjs'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless')
const { ImageAddon } = require('@xterm/addon-image')

function raster(data, width, height) {
  let pixels = new Uint8ClampedArray(data)
  return {
    kind: 'rgba',
    width,
    height,
    get data() {
      return pixels
    },
    close: vi.fn(() => {
      pixels = new Uint8ClampedArray()
    })
  }
}

// This fixture exercises protocol/storage ownership; codec and resampling parity need separate proof.
function backend() {
  const sources = []
  const fromRgba = (data, width, height) => {
    const source = raster(data, width, height)
    sources.push(source)
    return source
  }
  return {
    sources,
    fromRgba,
    getCellSize: () => ({ width: 2, height: 2 }),
    getColors: () => ({
      foreground: { rgba: 0xffffffff },
      background: { rgba: 0x123456ff },
      ansi: []
    }),
    decode: vi.fn((bytes, mime) => {
      if (mime !== 'image/png') {
        throw new Error('Fixture codec supports PNG only')
      }
      const image = PNG.sync.read(Buffer.from(bytes), { checkCRC: true })
      return fromRgba(image.data, image.width, image.height)
    }),
    inflate(bytes, byteLimit) {
      try {
        return inflateSync(bytes, { maxOutputLength: byteLimit })
      } catch (error) {
        if (error.code !== 'Z_DATA_ERROR') {
          throw error
        }
        return inflateRawSync(bytes, { maxOutputLength: byteLimit })
      }
    },
    crop(source, x, y, width, height) {
      const pixels = new Uint8ClampedArray(width * height * 4)
      for (let row = 0; row < height; row++) {
        const start = ((row + y) * source.width + x) * 4
        pixels.set(source.data.subarray(start, start + width * 4), row * width * 4)
      }
      return fromRgba(pixels, width, height)
    },
    resize(source, width, height) {
      const pixels = new Uint8ClampedArray(width * height * 4)
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          const offset =
            (Math.floor((row * source.height) / height) * source.width +
              Math.floor((col * source.width) / width)) *
            4
          pixels.set(source.data.subarray(offset, offset + 4), (row * width + col) * 4)
        }
      }
      return fromRgba(pixels, width, height)
    },
    offset(source, x, y, width, height) {
      const pixels = new Uint8ClampedArray(width * height * 4)
      for (let row = 0; row < Math.min(source.height, height - y); row++) {
        const count = Math.min(source.width, width - x)
        pixels.set(
          source.data.subarray(row * source.width * 4, (row * source.width + count) * 4),
          ((row + y) * width + x) * 4
        )
      }
      return fromRgba(pixels, width, height)
    }
  }
}

function createTerminal(rasterBackend = backend()) {
  const terminal = new Terminal({ cols: 20, rows: 10, allowProposedApi: true, logLevel: 'off' })
  const addon = new ImageAddon({
    enableSizeReports: false,
    storageLimit: 32,
    pixelLimit: 8_000_000,
    kittySizeLimit: 8 * 1024 * 1024,
    iipSizeLimit: 8 * 1024 * 1024,
    sixelSizeLimit: 8 * 1024 * 1024,
    rasterBackend
  })
  terminal.loadAddon(addon)
  return { terminal, addon, backend: rasterBackend }
}

function kitty(command, bytes) {
  return `\x1b_G${command};${Buffer.from(bytes).toString('base64')}\x1b\\`
}

function png() {
  const image = new PNG({ width: 4, height: 4 })
  for (let i = 0; i < image.data.length; i += 4) {
    image.data.set([255, 0, 0, 255], i)
  }
  return PNG.sync.write(image)
}

const sequences = [
  [
    'Kitty raw',
    () =>
      kitty(
        'a=T,f=32,s=4,v=4,i=7,q=2',
        Buffer.from(Array.from({ length: 16 }, () => [255, 0, 0, 255]).flat())
      )
  ],
  ['Kitty PNG', () => kitty('a=T,f=100,i=7,q=2', png())],
  [
    'Kitty compressed',
    () => kitty('a=T,f=32,s=4,v=4,o=z,i=7,q=2', deflateSync(Buffer.alloc(64, 255)))
  ],
  ['IIP PNG', () => `\x1b]1337;File=inline=1;width=4px;height=4px:${png().toString('base64')}\x07`],
  ['SIXEL', () => '\x1bPq"1;1;4;6#0;2;100;0;0#0!4~\x1b\\'],
  [
    'IIP QOI',
    () => {
      const bytes = Buffer.from([
        113, 111, 105, 102, 0, 0, 0, 2, 0, 0, 0, 1, 4, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255,
        0, 0, 0, 0, 0, 0, 0, 1
      ])
      return `\x1b]1337;File=inline=1;width=4px;height=2px:${bytes.toString('base64')}\x07`
    }
  ]
]

describe('execution-host image handlers with a synchronous raster backend', () => {
  it.each(sequences)(
    '%s consumes its image and following text in one synchronous write',
    (_name, sequence) => {
      const h = createTerminal()
      try {
        expect(typeof document).toBe('undefined')
        expect(typeof createImageBitmap).toBe('undefined')
        h.terminal._core.writeSync(`BEFORE${sequence()}AFTER`)
        expect(h.addon._storage._images.size).toBe(1)
        expect(
          Array.from({ length: 10 }, (_, row) =>
            h.terminal.buffer.active.getLine(row).translateToString(true)
          ).join('\n')
        ).toContain('AFTER')
        const source = [...h.addon._storage._images.values()][0].orig
        expect(source.kind).toBe('rgba')
        expect(source.data.byteLength).toBe(source.width * source.height * 4)
        expect(source.data[0]).toBe(255)
        h.addon.reset()
        expect(h.addon._storage._images.size).toBe(0)
        expect(source.close).toHaveBeenCalledOnce()
      } finally {
        h.terminal.dispose()
      }
    }
  )

  it('keeps virtual placement off the cursor and reuses the existing named placement map', () => {
    const h = createTerminal()
    try {
      h.terminal._core.writeSync(
        `\x1b[3;4H${kitty('a=T,f=100,i=7,U=1,p=9,c=3,r=2,q=2', png())}AFTER`
      )
      expect(h.terminal.buffer.active.getLine(2).translateToString(true)).toBe('   AFTER')
      const storage = h.addon._handlers.get('kitty')._kittyStorage
      expect(storage._virtualPlacements.get(7).get(9)).toMatchObject({ cols: 3, rows: 2 })
      const source = [...h.addon._storage._images.values()][0].orig
      h.terminal._core.writeSync(kitty('a=d,d=I,i=7,q=2', []))
      expect(source.close).toHaveBeenCalledOnce()
      expect(storage._virtualPlacements.size).toBe(0)
    } finally {
      h.terminal.dispose()
    }
  })

  it('uses one ownership chain through crop, resize, offsets, cursor preservation and disposal', () => {
    const h = createTerminal()
    try {
      h.terminal._core.writeSync(
        `\x1b[3;4H${kitty('a=T,f=100,i=7,x=1,y=1,w=2,h=2,c=2,r=2,X=1,Y=1,C=1,q=2', png())}AFTER`
      )
      expect(h.terminal.buffer.active.getLine(2).translateToString(true)).toBe('   AFTER')
      expect(h.backend.sources).toHaveLength(4)
      for (const source of h.backend.sources.slice(0, -1)) {
        expect(source.close).toHaveBeenCalledOnce()
      }
      const source = h.backend.sources.at(-1)
      expect([source.width, source.height]).toEqual([4, 4])
      expect([...source.data.subarray(0, 4)]).toEqual([0, 0, 0, 0])
      expect([...source.data.subarray(20, 24)]).toEqual([255, 0, 0, 255])
      h.terminal.dispose()
      expect(source.close).toHaveBeenCalledOnce()
    } finally {
      h.terminal.dispose()
    }
  })

  it('continues parsing when a backend rejects IIP decoding', () => {
    const b = backend()
    b.decode.mockImplementation(() => {
      throw new Error('invalid image')
    })
    const h = createTerminal(b)
    try {
      h.terminal._core.writeSync(`BEFORE${sequences[3][1]()}AFTER`)
      expect(h.terminal.buffer.active.getLine(0).translateToString(true)).toBe('BEFOREAFTER')
      expect(h.addon._storage._images.size).toBe(0)
    } finally {
      h.terminal.dispose()
    }
  })

  it.each([
    ['default', '', '', [18, 52, 86, 255]],
    ['explicit RGB', '\x1b[48;2;10;20;30m', '', [10, 20, 30, 255]],
    ['inverse', '\x1b[7m', '', [255, 255, 255, 255]],
    ['transparent', '', '0;1', [0, 0, 0, 0]]
  ])(
    'fills unpainted SIXEL pixels with the %s background',
    (_name, attributes, params, expected) => {
      const h = createTerminal()
      try {
        h.terminal._core.writeSync(`${attributes}\x1bP${params}q"1;1;2;6#0;2;100;0;0#0@\x1b\\AFTER`)
        const source = [...h.addon._storage._images.values()][0].orig
        expect([...source.data.subarray(0, 4)]).toEqual([255, 0, 0, 255])
        expect([...source.data.subarray(4, 8)]).toEqual(expected)
      } finally {
        h.terminal.dispose()
      }
    }
  )

  it('copies pooled SIXEL decoder pixels before the next image reuses them', () => {
    const h = createTerminal()
    try {
      h.terminal._core.writeSync(sequences[4][1]())
      const first = [...h.addon._storage._images.values()][0].orig
      h.terminal._core.writeSync('\x1bPq"1;1;4;6#0;2;0;0;100#0!4~\x1b\\AFTER')
      const sources = [...h.addon._storage._images.values()].map((spec) => spec.orig)
      expect(sources).toHaveLength(2)
      expect([...first.data.subarray(0, 4)]).toEqual([255, 0, 0, 255])
      expect([...sources[1].data.subarray(0, 4)]).toEqual([0, 0, 255, 255])
      expect(first.data.buffer).not.toBe(sources[1].data.buffer)
    } finally {
      h.terminal.dispose()
    }
  })

  it('freezes placement cell metrics when the host later changes its geometry', () => {
    const b = backend()
    const current = { width: 2, height: 2 }
    b.getCellSize = () => current
    const h = createTerminal(b)
    try {
      h.terminal._core.writeSync(sequences[1][1]())
      const spec = [...h.addon._storage._images.values()][0]
      current.width = 4
      current.height = 4
      expect(spec.origCellSize).toEqual({ width: 2, height: 2 })
      expect(h.addon._renderer.cellSize).toEqual({ width: 4, height: 4 })
    } finally {
      h.terminal.dispose()
    }
  })

  it('contains SIXEL raster failures and continues the synchronous stream', () => {
    const b = backend()
    b.fromRgba = () => {
      throw new Error('raster allocation failed')
    }
    const h = createTerminal(b)
    try {
      h.terminal._core.writeSync(`BEFORE${sequences[4][1]()}AFTER`)
      expect(h.terminal.buffer.active.getLine(0).translateToString(true)).toBe('BEFOREAFTER')
      expect(h.addon._storage._images.size).toBe(0)
    } finally {
      h.terminal.dispose()
    }
  })

  it('releases an invalid backend result before continuing after a Kitty error', () => {
    const b = backend()
    const invalid = raster([255, 0, 0], 1, 1)
    b.decode.mockReturnValue(invalid)
    const h = createTerminal(b)
    const replies = []
    h.terminal.onData((reply) => replies.push(reply))
    try {
      h.terminal._core.writeSync(`BEFORE${kitty('a=T,f=100,i=7', png())}AFTER`)
      expect(h.terminal.buffer.active.getLine(0).translateToString(true)).toBe('BEFOREAFTER')
      expect(invalid.close).toHaveBeenCalledOnce()
      expect(replies).toEqual(['\x1b_Gi=7;EINVAL:image rendering failed\x1b\\'])
      expect(h.addon._storage._images.size).toBe(0)
    } finally {
      h.terminal.dispose()
    }
  })

  it('closes alternate-buffer sources while retaining normal-buffer sources', () => {
    const h = createTerminal()
    try {
      h.terminal._core.writeSync(sequences[1][1]())
      const normal = h.backend.sources.at(-1)
      h.terminal._core.writeSync(`\x1b[?1049h${kitty('a=T,f=100,i=8,q=2', png())}`)
      const alternate = h.backend.sources.at(-1)
      h.terminal._core.writeSync('\x1b[?1049lAFTER')
      expect(alternate.close).toHaveBeenCalledOnce()
      expect(normal.close).not.toHaveBeenCalled()
      expect(h.addon._storage._images.size).toBe(1)
      h.terminal.dispose()
      expect(normal.close).toHaveBeenCalledOnce()
    } finally {
      h.terminal.dispose()
    }
  })
})
