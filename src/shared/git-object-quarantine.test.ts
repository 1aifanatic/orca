import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetGitObjectQuarantineSweepForTests,
  _settleGitObjectQuarantineSweepsForTests,
  createGitObjectQuarantine,
  GIT_OBJECT_QUARANTINE_DIR_PREFIX,
  STALE_GIT_OBJECT_QUARANTINE_AGE_MS,
  type GitObjectQuarantineEnv
} from './git-object-quarantine'

const { failedRenameTargets, objectsReaddirGate } = vi.hoisted(() => {
  // Why: holds the stale sweep's `objects/` listing so a test can show the command does not wait for it.
  const objectsReaddirGate: { current: Promise<void> | undefined } = { current: undefined }
  return { failedRenameTargets: new Set<string>(), objectsReaddirGate }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (failedRenameTargets.has(basename(to))) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      }
      return actual.rename(from, to)
    },
    readdir: async (path: string) => {
      if (basename(path) === 'objects') {
        await objectsReaddirGate.current
      }
      return actual.readdir(path)
    }
  }
})

describe('createGitObjectQuarantine', () => {
  let root: string
  let objects: string

  beforeEach(() => {
    _resetGitObjectQuarantineSweepForTests()
    root = mkdtempSync(join(tmpdir(), 'orca-object-quarantine-'))
    objects = join(root, 'objects')
    mkdirSync(join(objects, 'pack'), { recursive: true })
  })

  afterEach(async () => {
    await _settleGitObjectQuarantineSweepsForTests()
    failedRenameTargets.clear()
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  const resolveNative = () => async () => ({ hostPath: objects, gitPath: objects })
  const scratchDirs = (): string[] =>
    readdirSync(objects).filter((entry) => entry.startsWith(GIT_OBJECT_QUARANTINE_DIR_PREFIX))

  it('points Git at a scratch dir inside objects/ and removes it afterwards', async () => {
    let seen: GitObjectQuarantineEnv | undefined

    await expect(
      createGitObjectQuarantine(resolveNative()).run(async (env) => {
        seen = env
        expect(scratchDirs()).toHaveLength(1)
        return 'ok'
      })
    ).resolves.toBe('ok')

    expect(seen).toEqual({
      GIT_OBJECT_DIRECTORY: expect.stringContaining(
        join(objects, GIT_OBJECT_QUARANTINE_DIR_PREFIX)
      ),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objects
    })
    expect(scratchDirs()).toEqual([])
  })

  it('removes the scratch dir when the command fails', async () => {
    const failure = new Error('merge-tree failed')

    await expect(
      createGitObjectQuarantine(resolveNative()).run(async () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(scratchDirs()).toEqual([])
  })

  it.each([
    ['the objects dir is unknown', async () => undefined],
    [
      'resolving the objects dir fails',
      async () => {
        throw new Error('x')
      }
    ],
    [
      'the scratch dir cannot be created',
      async () => ({ hostPath: '/no/such/objects', gitPath: '/no/such/objects' })
    ]
  ])('runs the command unquarantined when %s', async (_label, resolve) => {
    const command = vi.fn(async () => 'ok')

    await expect(createGitObjectQuarantine(resolve).run(command)).resolves.toBe('ok')

    expect(command).toHaveBeenCalledWith(undefined)
  })

  it('resolves the objects dir once and gives every run its own scratch dir', async () => {
    const resolve = vi.fn(resolveNative())
    const quarantine = createGitObjectQuarantine(resolve)
    const seen: (string | undefined)[] = []

    await quarantine.run(async (env) => seen.push(env?.GIT_OBJECT_DIRECTORY))
    await quarantine.run(async (env) => seen.push(env?.GIT_OBJECT_DIRECTORY))

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(new Set(seen).size).toBe(2)
  })

  it('creates the scratch dir in host spelling but hands WSL Git its Linux spelling', async () => {
    let seen: GitObjectQuarantineEnv | undefined

    await createGitObjectQuarantine(async () => ({
      hostPath: objects,
      gitPath: '/home/me/repo/.git/objects'
    })).run(async (env) => {
      seen = env
      expect(scratchDirs()).toHaveLength(1)
    })

    expect(seen?.GIT_OBJECT_DIRECTORY).toMatch(
      new RegExp(`^/home/me/repo/\\.git/objects/${GIT_OBJECT_QUARANTINE_DIR_PREFIX}\\w+$`)
    )
    expect(seen?.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBe('/home/me/repo/.git/objects')
  })

  it.each([
    ['/plain/objects', '/plain/objects'],
    ['/odd:dir/objects', '"/odd:dir/objects"'],
    ['/quo"te\\dir/objects', '"/quo\\"te\\\\dir/objects"'],
    ['C:\\repo\\.git\\objects', 'C:\\repo\\.git\\objects'],
    ['C:\\a;b\\.git\\objects', '"C:\\\\a;b\\\\.git\\\\objects"']
  ])('spells alternates for %s so Git reads one entry', async (gitPath, expected) => {
    let seen: GitObjectQuarantineEnv | undefined

    await createGitObjectQuarantine(async () => ({ hostPath: objects, gitPath })).run(
      async (env) => {
        seen = env
      }
    )

    expect(seen?.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBe(expected)
  })

  it('moves packs Git fetched into the scratch dir to the real store, index included', async () => {
    await createGitObjectQuarantine(resolveNative()).run(async (env) => {
      const scratchPack = join(env?.GIT_OBJECT_DIRECTORY ?? '', 'pack')
      mkdirSync(scratchPack)
      for (const file of ['pack-abc1.pack', 'pack-abc1.idx', 'pack-abc1.promisor']) {
        writeFileSync(join(scratchPack, file), file)
      }
      // A pack still being written has no index yet; Git could not use it.
      writeFileSync(join(scratchPack, 'pack-def2.pack'), 'partial')
      writeFileSync(join(scratchPack, 'tmp_pack_XYZ'), 'partial')
      mkdirSync(join(env?.GIT_OBJECT_DIRECTORY ?? '', 'ab'))
      writeFileSync(join(env?.GIT_OBJECT_DIRECTORY ?? '', 'ab', 'cdef'), 'merge-tree output')
    })

    expect(readdirSync(join(objects, 'pack')).sort()).toEqual([
      'pack-abc1.idx',
      'pack-abc1.pack',
      'pack-abc1.promisor'
    ])
    expect(existsSync(join(objects, 'ab'))).toBe(false)
    expect(scratchDirs()).toEqual([])
  })

  it('rolls back a pack whose index could not be moved, keeping the other packs', async () => {
    failedRenameTargets.add('pack-abc1.idx')

    await createGitObjectQuarantine(resolveNative()).run(async (env) => {
      const scratchPack = join(env?.GIT_OBJECT_DIRECTORY ?? '', 'pack')
      mkdirSync(scratchPack)
      for (const file of ['pack-abc1.pack', 'pack-abc1.idx', 'pack-def2.pack', 'pack-def2.idx']) {
        writeFileSync(join(scratchPack, file), file)
      }
    })

    expect(readdirSync(join(objects, 'pack')).sort()).toEqual(['pack-def2.idx', 'pack-def2.pack'])
    expect(scratchDirs()).toEqual([])
  })

  it('leaves a pack the real store already has untouched', async () => {
    writeFileSync(join(objects, 'pack', 'pack-abc1.pack'), 'installed')
    writeFileSync(join(objects, 'pack', 'pack-abc1.idx'), 'installed')

    await createGitObjectQuarantine(resolveNative()).run(async (env) => {
      const scratchPack = join(env?.GIT_OBJECT_DIRECTORY ?? '', 'pack')
      mkdirSync(scratchPack)
      writeFileSync(join(scratchPack, 'pack-abc1.pack'), 'refetched')
      writeFileSync(join(scratchPack, 'pack-abc1.idx'), 'refetched')
    })

    expect(readFileSync(join(objects, 'pack', 'pack-abc1.pack'), 'utf8')).toBe('installed')
    expect(readFileSync(join(objects, 'pack', 'pack-abc1.idx'), 'utf8')).toBe('installed')
  })

  it('never moves a fetched pack’s `.keep` into the real store', async () => {
    await createGitObjectQuarantine(resolveNative()).run(async (env) => {
      const scratchPack = join(env?.GIT_OBJECT_DIRECTORY ?? '', 'pack')
      mkdirSync(scratchPack)
      for (const file of ['pack-abc1.pack', 'pack-abc1.idx', 'pack-abc1.keep']) {
        writeFileSync(join(scratchPack, file), file)
      }
    })

    expect(readdirSync(join(objects, 'pack')).sort()).toEqual(['pack-abc1.idx', 'pack-abc1.pack'])
  })

  describe('stale scratch sweep', () => {
    const DAY = 24 * 60 * 60 * 1000
    const makeDir = (name: string, ageMs: number): string => {
      const dir = join(objects, name)
      mkdirSync(dir)
      const modified = (Date.now() - ageMs) / 1000
      utimesSync(dir, modified, modified)
      return dir
    }

    it('removes scratch dirs past Git’s own two-week expiry and keeps younger ones', async () => {
      expect(STALE_GIT_OBJECT_QUARANTINE_AGE_MS).toBe(14 * DAY)
      const expired = makeDir(`${GIT_OBJECT_QUARANTINE_DIR_PREFIX}old`, 15 * DAY)
      const young = makeDir(`${GIT_OBJECT_QUARANTINE_DIR_PREFIX}young`, 13 * DAY)
      const gitOwn = makeDir('tmp_objdir-incoming-old', 15 * DAY)

      await createGitObjectQuarantine(resolveNative()).run(async () => {})
      await _settleGitObjectQuarantineSweepsForTests()

      expect(existsSync(expired)).toBe(false)
      expect(existsSync(young)).toBe(true)
      expect(existsSync(gitOwn)).toBe(true)
    })

    it('sweeps once per objects dir', async () => {
      await createGitObjectQuarantine(resolveNative()).run(async () => {})
      await _settleGitObjectQuarantineSweepsForTests()
      const expired = makeDir(`${GIT_OBJECT_QUARANTINE_DIR_PREFIX}old`, 15 * DAY)

      await createGitObjectQuarantine(resolveNative()).run(async () => {})
      await _settleGitObjectQuarantineSweepsForTests()

      expect(existsSync(expired)).toBe(true)
    })

    it('does not hold the command back while the sweep runs', async () => {
      let releaseSweep = (): void => {}
      objectsReaddirGate.current = new Promise((resolve) => {
        releaseSweep = resolve
      })
      let commandRan = false
      try {
        const running = createGitObjectQuarantine(resolveNative()).run(async () => {
          commandRan = true
        })
        await vi.waitFor(() => expect(commandRan).toBe(true))
        releaseSweep()
        await running
      } finally {
        releaseSweep()
        objectsReaddirGate.current = undefined
      }
    })
  })
})
