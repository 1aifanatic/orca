import {
  Dirent,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import * as realFs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../shared/windows-transient-lock-removal'

// Why untyped: the fakes below implement only the call shapes the walk uses.
const walkFs = vi.hoisted(() => {
  const state: { current: object | null; inFlight: number; maxInFlight: number } = {
    current: null,
    inFlight: 0,
    maxInFlight: 0
  }
  return state
})

vi.mock('./asar-transparent-fs', () => ({
  asarTransparentFs: () => walkFs.current
}))

import { removeTreeWithBoundedFsCalls } from './tree-removal-walk'

const options = { recursive: true, force: true }
const roots: string[] = []

function counted<A extends unknown[], R>(call: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    walkFs.inFlight += 1
    walkFs.maxInFlight = Math.max(walkFs.maxInFlight, walkFs.inFlight)
    try {
      return await call(...args)
    } finally {
      walkFs.inFlight -= 1
    }
  }
}

type WalkFsOverrides = Record<string, (...args: never[]) => Promise<unknown>>

function useCountedRealFs(overrides: WalkFsOverrides = {}): void {
  walkFs.inFlight = 0
  walkFs.maxInFlight = 0
  walkFs.current = {
    lstat: counted(realFs.lstat),
    readdir: counted(realFs.readdir),
    rm: counted(realFs.rm),
    rmdir: counted(realFs.rmdir),
    unlink: counted(realFs.unlink),
    ...overrides
  }
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-tree-walk-'))
  roots.push(root)
  return root
}

function buildTree(target: string, directories: number, filesPerDirectory: number): string {
  for (let d = 0; d < directories; d++) {
    const directory = join(target, `pkg-${d}`, 'lib')
    mkdirSync(directory, { recursive: true })
    for (let f = 0; f < filesPerDirectory; f++) {
      writeFileSync(join(directory, `${f}.js`), 'x')
    }
  }
  return target
}

// Why: a directory listing may classify a link (a Windows junction) as a directory; only lstat decides.
async function readdirReportingLinksAsDirectories(path: string): Promise<Dirent[]> {
  const entries = await realFs.readdir(path, { withFileTypes: true })
  return entries.map((entry) =>
    Object.assign(entry, {
      isDirectory: () => entry.isSymbolicLink() || Dirent.prototype.isDirectory.call(entry)
    })
  )
}

afterEach(() => {
  walkFs.current = null
})

afterAll(() => {
  for (const root of roots) {
    removeTreeSync(root)
  }
})

describe('removeTreeWithBoundedFsCalls', () => {
  it('never has more than two fs calls in flight across concurrent deletes', async () => {
    useCountedRealFs()
    const root = makeRoot()
    const targets = Array.from({ length: 10 }, (_, i) => buildTree(join(root, `t${i}`), 4, 8))

    await Promise.all(
      targets.map((target, i) =>
        removeTreeWithBoundedFsCalls(target, options, i % 2 ? 'interactive' : 'background')
      )
    )

    expect(targets.filter((target) => existsSync(target))).toEqual([])
    expect(walkFs.maxInFlight).toBe(2)
  })

  it('gives an interactive delete the next free slot ahead of queued background calls', async () => {
    const started: string[] = []
    const pending = new Map<string, () => void>()
    const hold = (label: string): Promise<void> => {
      started.push(label)
      return new Promise((resolve) => pending.set(label, resolve))
    }
    walkFs.current = {
      lstat: vi.fn(async (path: string) => {
        await hold(`lstat ${path}`)
        return { isDirectory: () => false }
      }),
      readdir: vi.fn(),
      unlink: vi.fn((path: string) => hold(`unlink ${path}`))
    }
    const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
    const release = async (label: string): Promise<void> => {
      pending.get(label)?.()
      pending.delete(label)
      await flush()
    }

    const deletes = [
      removeTreeWithBoundedFsCalls('/bg-1', options, 'background'),
      removeTreeWithBoundedFsCalls('/bg-2', options, 'background'),
      removeTreeWithBoundedFsCalls('/bg-3', options, 'background')
    ]
    await flush()
    deletes.push(removeTreeWithBoundedFsCalls('/folder', options, 'interactive'))
    await flush()
    expect(started).toEqual(['lstat /bg-1', 'lstat /bg-2'])

    await release('lstat /bg-1')
    expect(started.at(-1)).toBe('lstat /folder')

    while (pending.size > 0) {
      await release([...pending.keys()][0])
    }
    await Promise.all(deletes)
  })

  // Why: Windows refuses a plain unlink/rmdir of a read-only or briefly locked entry; `rm` clears the
  // read-only flag and retries.
  it('falls back to rm for an entry a plain unlink or rmdir refuses', async () => {
    const refuse = async (): Promise<never> => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    }
    useCountedRealFs({ unlink: refuse, rmdir: refuse })
    const target = buildTree(join(makeRoot(), 'tree'), 2, 3)

    await removeTreeWithBoundedFsCalls(target, options, 'interactive')

    expect(existsSync(target)).toBe(false)
  })

  it('unlinks a directory symlink that points out of the tree without touching its target', async () => {
    useCountedRealFs()
    const root = makeRoot()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'x')
    const target = buildTree(join(root, 'tree'), 1, 2)
    symlinkSync(outside, join(target, 'linked'), 'junction')

    await removeTreeWithBoundedFsCalls(target, options, 'background')

    expect(existsSync(target)).toBe(false)
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
  })

  it('does not follow a link that the directory listing reports as a directory', async () => {
    const root = makeRoot()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'x')
    const target = buildTree(join(root, 'tree'), 1, 2)
    symlinkSync(outside, join(target, 'linked'), 'junction')
    useCountedRealFs({ readdir: readdirReportingLinksAsDirectories })

    await removeTreeWithBoundedFsCalls(target, options, 'background')

    expect(existsSync(target)).toBe(false)
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
  })

  it('removes only the link when the target itself is a directory symlink', async () => {
    useCountedRealFs()
    const root = makeRoot()
    const outside = buildTree(join(root, 'outside'), 1, 2)
    const link = join(root, 'link')
    symlinkSync(outside, link, 'junction')

    await removeTreeWithBoundedFsCalls(link, options, 'interactive')

    expect(existsSync(link)).toBe(false)
    expect(existsSync(join(outside, 'pkg-0', 'lib', '0.js'))).toBe(true)
  })

  it('completes on a link loop, even one listed as a directory', async () => {
    useCountedRealFs({ readdir: readdirReportingLinksAsDirectories })
    const root = makeRoot()
    const target = buildTree(join(root, 'tree'), 1, 1)
    symlinkSync(target, join(target, 'pkg-0', 'lib', 'loop'), 'junction')

    await removeTreeWithBoundedFsCalls(target, options, 'background')

    expect(existsSync(target)).toBe(false)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'rejects with the fs code and the stuck entry after removing everything else',
    async () => {
      const root = makeRoot()
      const target = buildTree(join(root, 'tree'), 6, 4)
      const locked = join(target, 'pkg-1', 'lib')
      useCountedRealFs()
      chmodSync(locked, 0o500)
      try {
        await expect(
          removeTreeWithBoundedFsCalls(target, options, 'interactive')
        ).rejects.toMatchObject({
          code: 'EACCES',
          path: expect.stringContaining(join('pkg-1', 'lib'))
        })
        expect(walkFs.inFlight).toBe(0)
        expect(readdirSync(target)).toEqual(['pkg-1'])
        expect(readdirSync(locked)).toHaveLength(4)
      } finally {
        chmodSync(locked, 0o700)
      }
    }
  )
})
