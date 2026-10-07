import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NodeFileReadTooLargeError,
  readNodeFileSyncWithinLimit,
  readNodeFileWithinLimit
} from './node-bounded-file-reader'

const directories: string[] = []

function createInput(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-file-window-'))
  directories.push(directory)
  const path = join(directory, 'image-source')
  writeFileSync(path, content)
  return path
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true })
  }
})

const readers = [
  { mode: 'sync', read: readNodeFileSyncWithinLimit },
  { mode: 'async', read: readNodeFileWithinLimit }
]

describe.each(readers)('$mode bounded file windows', ({ read }) => {
  it('reads only the selected bytes of a larger sparse source', async () => {
    const path = createInput('header')
    const descriptor = openSync(path, 'r+')
    try {
      ftruncateSync(descriptor, 1024 * 1024)
      writeSync(descriptor, Buffer.from('pixels'), 0, 6, 65536)
    } finally {
      closeSync(descriptor)
    }
    const result = await read(path, 6, {
      regularFileOnly: true,
      window: { offset: 65536, length: 6 }
    })
    expect(result.buffer.toString()).toBe('pixels')
    expect(result.buffer.byteLength).toBe(6)
    expect(result.stats.size).toBe(1024 * 1024)
    await expect(async () => read(path, 6)).rejects.toThrow(NodeFileReadTooLargeError)
  })

  it('reads the remaining extent when length is omitted and permits an empty EOF window', async () => {
    const path = createInput('headerpixels')
    expect((await read(path, 6, { window: { offset: 6 } })).buffer.toString()).toBe('pixels')
    expect((await read(path, 0, { window: { offset: 12, length: 0 } })).buffer.byteLength).toBe(0)
  })

  it.each([
    { offset: 7 },
    { offset: 5, length: 2 },
    { offset: Number.MAX_SAFE_INTEGER, length: Number.MAX_SAFE_INTEGER }
  ])('rejects a window outside the file: $offset / $length', async (window) => {
    await expect(async () => read(createInput('pixels'), 8, { window })).rejects.toThrow(
      'File is smaller than the requested window'
    )
  })

  it('applies the byte budget to the selected extent', async () => {
    await expect(async () =>
      read(createInput('headerpixels'), 5, { window: { offset: 6 } })
    ).rejects.toEqual(new NodeFileReadTooLargeError(6, 5))
  })

  it.each([
    { offset: -1 },
    { offset: 0.5 },
    { offset: Infinity },
    { offset: 0, length: -1 },
    { offset: 0, length: Number.NaN },
    { offset: 0, length: Number.MAX_SAFE_INTEGER + 1 }
  ])(
    'rejects invalid window values before filesystem access: $offset / $length',
    async (window) => {
      const path = join(tmpdir(), 'orca-file-window-missing', 'missing')
      await expect(async () => read(path, 8, { window })).rejects.toThrow(RangeError)
    }
  )

  it('rejects directories with regular-file mode', async () => {
    createInput('pixels')
    await expect(async () =>
      read(directories.at(-1)!, 8, { regularFileOnly: true })
    ).rejects.toThrow('Expected a regular file')
  })

  it.skipIf(process.platform === 'win32')('follows a symlink to a regular source', async () => {
    const path = createInput('headerpixels')
    const link = `${path}-link`
    symlinkSync(path, link)
    expect(
      (
        await read(link, 6, { regularFileOnly: true, window: { offset: 6, length: 6 } })
      ).buffer.toString()
    ).toBe('pixels')
  })
})
