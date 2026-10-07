import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless')
const { ImageAddon } = require('@xterm/addon-image')

function createTerminal() {
  const terminal = new Terminal({ allowProposedApi: true })
  const addon = new ImageAddon({
    enableSizeReports: false,
    showPlaceholder: false,
    storageLimit: 32,
    kittySizeLimit: 8 * 1024 * 1024
  })
  terminal.loadAddon(addon)
  return { terminal, handler: addon._handlers.get('kitty') }
}

afterEach(() => vi.unstubAllGlobals())

describe('Kitty encoded source ownership', () => {
  it('retains synchronous source bytes through decoder reuse without browser globals', () => {
    const { terminal, handler } = createTerminal()
    try {
      terminal._core.writeSync('\x1b_Ga=t,f=32,s=1,v=1,i=7,q=2;AQIDBA==\x1b\\first')
      terminal._core.writeSync('\x1b_Ga=t,f=32,s=1,v=1,i=8,q=2;BQYHCA==\x1b\\second')
      const first = handler._kittyStorage.getImage(7).data
      const second = handler._kittyStorage.getImage(8).data
      expect(first).toBeInstanceOf(Uint8Array)
      expect([...first]).toEqual([1, 2, 3, 4])
      expect([...second]).toEqual([5, 6, 7, 8])
      expect(first.buffer.byteLength).toBe(4)
      expect(first.buffer).not.toBe(second.buffer)
      expect(terminal.buffer.active.getLine(0).translateToString(true)).toBe('firstsecond')
    } finally {
      terminal.dispose()
    }
  })

  it('copies only the source window and releases its caller-owned backing allocation', () => {
    const { terminal, handler } = createTerminal()
    try {
      const allocation = new Uint8Array(1024 * 1024)
      const window = allocation.subarray(1, 5)
      window.set([1, 2, 3, 4])
      handler._kittyStorage.storeImage(7, { data: window, width: 1, height: 1, format: 32 })
      const source = handler._kittyStorage.getImage(7).data
      window.fill(0)
      expect(source).toBeInstanceOf(Uint8Array)
      expect([...source]).toEqual([1, 2, 3, 4])
      expect(source.byteOffset).toBe(0)
      expect(source.buffer.byteLength).toBe(4)
      expect(source.buffer).not.toBe(allocation.buffer)
    } finally {
      terminal.dispose()
    }
  })

  it('reads retained raw pixels without another encoded-source copy', async () => {
    const { terminal, handler } = createTerminal()
    try {
      terminal._core.writeSync('\x1b_Ga=t,f=32,s=1,v=1,i=7,q=2;AQIDBA==\x1b\\')
      const image = handler._kittyStorage.getImage(7)
      vi.stubGlobal(
        'ImageData',
        class {
          constructor(data, width, height) {
            this.data = data
            this.width = width
            this.height = height
          }
        }
      )
      const decode = vi.fn(async () => ({ width: 1, height: 1, close() {} }))
      vi.stubGlobal('createImageBitmap', decode)
      await handler._createBitmap(image)
      expect(decode).toHaveBeenCalledOnce()
      expect(decode.mock.calls[0][0].data.buffer).toBe(image.data.buffer)
      expect([...image.data]).toEqual([1, 2, 3, 4])
    } finally {
      terminal.dispose()
    }
  })

  it.each([2, 4])('decodes %i RGB pixels from an unaligned input window', async (pixels) => {
    const { terminal, handler } = createTerminal()
    try {
      const allocation = new Uint8Array(1 + pixels * 3)
      const input = allocation.subarray(1)
      input.set(Array.from({ length: input.length }, (_, index) => index + 1))
      handler._kittyStorage.storeImage(7, { data: input, width: pixels, height: 1, format: 24 })
      const image = handler._kittyStorage.getImage(7)
      vi.stubGlobal(
        'ImageData',
        class {
          constructor(data, width, height) {
            this.data = data
            this.width = width
            this.height = height
          }
        }
      )
      const decode = vi.fn(async () => ({ width: pixels, height: 1, close() {} }))
      vi.stubGlobal('createImageBitmap', decode)
      await handler._createBitmap(image)
      expect([...decode.mock.calls[0][0].data]).toEqual(
        Array.from({ length: pixels }, (_, index) => [
          index * 3 + 1,
          index * 3 + 2,
          index * 3 + 3,
          255
        ]).flat()
      )
      expect([...image.data]).toEqual([...input])
    } finally {
      terminal.dispose()
    }
  })
})
