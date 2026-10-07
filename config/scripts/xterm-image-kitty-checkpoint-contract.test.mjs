import { describe, expect, it, vi } from 'vitest'
import { terminal } from './xterm-image-checkpoint-test-terminal.mjs'

const rgba = Buffer.from([255, 100, 0, 255, 255, 100, 0, 255, 255, 100, 0, 255, 255, 100, 0, 255])
const kitty = (command, bytes = rgba) => `\x1b_G${command};${bytes.toString('base64')}\x1b\\`
const write = (h, sequence) => h.core._core.writeSync(sequence)

async function restore(source, target) {
  const decoded = source.storage.captureCheckpoint(1024 * 1024)
  const protocol = source.kittyStorage.captureCheckpoint(1024 * 1024)
  const ansi = source.serializer.serialize()
  source.core.dispose()
  try {
    write(target, ansi)
    await target.storage.restoreCheckpoint(decoded)
    target.kittyStorage.restoreCheckpoint(protocol, 8 * 1024 * 1024)
  } finally {
    decoded.dispose()
    protocol.dispose()
  }
}

describe('Kitty sources and placement checkpoint component', () => {
  it('restores undeployed sources for a placement-only command and preserves the automatic ID counter', async () => {
    const source = terminal()
    const target = terminal()
    try {
      write(source, kitty('a=t,f=32,s=2,v=2,q=2'))
      write(source, kitty('a=t,f=32,s=2,v=2,q=2'))
      await restore(source, target)
      expect(target.kittyStorage.images.size).toBe(2)
      expect(target.storage._images.size).toBe(0)
      write(target, kitty('a=p,i=2,q=2', Buffer.alloc(0)))
      expect(target.storage._images.size).toBe(1)
      expect([...target.storage._images.values()][0].orig.data).toEqual(new Uint8ClampedArray(rgba))
      write(target, kitty('a=t,f=32,s=2,v=2,q=2'))
      expect(target.kittyStorage.lastImageId).toBe(3)
      expect([...target.kittyStorage.images.keys()]).toEqual([1, 2, 3])
    } finally {
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('restores multiple named virtual placements and their deletion ownership', async () => {
    const source = terminal()
    const target = terminal()
    try {
      write(source, kitty('a=T,f=32,s=2,v=2,i=2147483655,U=1,p=11,c=2,r=2,q=2'))
      write(source, kitty('a=p,i=2147483655,U=1,p=12,c=3,r=4,q=2', Buffer.alloc(0)))
      await restore(source, target)
      const placements = target.kittyStorage._virtualPlacements.get(2147483655)
      expect([...placements.keys()]).toEqual([11, 12])
      expect(placements.get(12)).toMatchObject({ cols: 3, rows: 4 })
      const retained = target.storage.getImageSpec(placements.get(12).storageId).orig
      write(target, kitty('a=d,d=I,i=2147483655,p=11,q=2', Buffer.alloc(0)))
      expect([...placements.keys()]).toEqual([12])
      expect(retained.data.byteLength).toBe(16)
      write(target, kitty('a=d,d=I,i=2147483655,p=12,q=2', Buffer.alloc(0)))
      expect(retained.data.byteLength).toBe(0)
      expect(target.storage._images.size).toBe(0)
      expect(target.kittyStorage.images.size).toBe(0)
    } finally {
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('preserves the latest physical reverse mapping when older placements share its Kitty ID', async () => {
    const source = terminal()
    const target = terminal()
    try {
      write(source, kitty('a=T,f=32,s=2,v=2,i=7,q=2'))
      write(source, kitty('a=p,i=7,q=2', Buffer.alloc(0)))
      const ids = [...source.storage._images.keys()]
      await restore(source, target)
      expect(target.kittyStorage.kittyIdToStorageId.get(7)).toBe(ids[1])
      target.storage.deleteImage(ids[0])
      expect(target.kittyStorage.kittyIdToStorageId.get(7)).toBe(ids[1])
      write(target, kitty('a=d,d=i,i=7,q=2', Buffer.alloc(0)))
      expect(target.storage._images.size).toBe(0)
      expect(target.kittyStorage.images.has(7)).toBe(true)
    } finally {
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('retains a decoded prototype whose encoded source was independently evicted', async () => {
    const source = terminal()
    const target = terminal()
    try {
      write(source, kitty('a=T,f=32,s=2,v=2,i=7,U=1,p=11,c=2,r=2,q=2'))
      source.kittyStorage._images.delete(7)
      await restore(source, target)
      expect(target.kittyStorage.images.has(7)).toBe(false)
      expect(target.kittyStorage._virtualPlacements.get(7).has(11)).toBe(true)
      write(target, kitty('a=d,d=I,i=7,p=11,q=2', Buffer.alloc(0)))
      expect(target.storage._images.size).toBe(0)
      expect(target.kittyStorage._virtualStorageIds.size).toBe(0)
    } finally {
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('owns copied source bytes after reset and exposes only bounded resource windows', () => {
    const source = terminal()
    let checkpoint
    try {
      write(source, kitty('a=t,f=32,s=2,v=2,i=7,q=2'))
      checkpoint = source.kittyStorage.captureCheckpoint(1024)
      const id = checkpoint.metadata.images[0].resourceId
      checkpoint.readResource(id, 0, 16).fill(0)
      source.kittyStorage.getImage(7).data.fill(0)
      source.addon.reset()
      expect(checkpoint.readResource(id, 0, 16)).toEqual(new Uint8Array(rgba))
      expect(Object.isFrozen(checkpoint.metadata.images[0])).toBe(true)
      expect(() => checkpoint.readResource(id, 0, 262145)).toThrow()
      checkpoint.dispose()
      expect(() => checkpoint.readResource(id, 0, 1)).toThrow()
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
    }
  })

  it.each(['lease budget', 'target payload limit', 'missing decoded placement'])(
    'rejects %s without replacing target ownership',
    (reason) => {
      const source = terminal()
      const target = terminal()
      let checkpoint
      try {
        write(
          source,
          kitty(`a=${reason === 'missing decoded placement' ? 'T' : 't'},f=32,s=2,v=2,i=7,q=2`)
        )
        write(target, kitty('a=t,f=32,s=2,v=2,i=9,q=2'))
        const original = target.kittyStorage.getImage(9)
        if (reason === 'lease budget') {
          expect(() => source.kittyStorage.captureCheckpoint(15)).toThrow(/budget/i)
        } else {
          checkpoint = source.kittyStorage.captureCheckpoint(1024)
          expect(() =>
            target.kittyStorage.restoreCheckpoint(
              checkpoint,
              reason === 'target payload limit' ? 15 : 1024
            )
          ).toThrow()
        }
        expect(target.kittyStorage.getImage(9)).toBe(original)
        expect(target.kittyStorage.images.size).toBe(1)
      } finally {
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it('installs maps without cursor movement or terminal replies', async () => {
    const source = terminal()
    const target = terminal()
    const replies = vi.fn()
    target.core.onData(replies)
    try {
      write(source, kitty('a=T,f=32,s=2,v=2,i=7,q=2'))
      await restore(source, target)
      expect(target.core.buffer.active.cursorX).toBe(1)
      expect(target.core.buffer.active.cursorY).toBe(0)
      expect(replies).not.toHaveBeenCalled()
    } finally {
      source.core.dispose()
      target.core.dispose()
    }
  })
})
