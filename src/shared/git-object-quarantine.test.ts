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
import { hostname, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetGitObjectQuarantineSweepForTests,
  createGitObjectQuarantine,
  GIT_OBJECT_QUARANTINE_DIR_PREFIX,
  GIT_OBJECT_QUARANTINE_OWNER_FILE,
  gitObjectQuarantineOwner,
  STALE_GIT_OBJECT_QUARANTINE_AGE_MS,
  MAX_GIT_OBJECT_QUARANTINE_AGE_MS,
  type GitObjectQuarantineEnv,
  type GitObjectQuarantineOwner
} from './git-object-quarantine'

const { failedRenameTargets } = vi.hoisted(() => ({ failedRenameTargets: new Set<string>() }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (failedRenameTargets.has(basename(to))) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      }
      return actual.rename(from, to)
    }
  }
})

const EXITED_PID = 2_000_000_001
const OTHER_USER_PID = 2_000_000_002

describe('createGitObjectQuarantine', () => {
  let root: string
  let objects: string

  beforeEach(() => {
    _resetGitObjectQuarantineSweepForTests()
    root = mkdtempSync(join(tmpdir(), 'orca-object-quarantine-'))
    objects = join(root, 'objects')
    mkdirSync(join(objects, 'pack'), { recursive: true })
  })

  afterEach(() => {
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

  it('records this process as the owner of its scratch dir', async () => {
    let owner: unknown

    await createGitObjectQuarantine(resolveNative()).run(async (env) => {
      owner = JSON.parse(
        readFileSync(
          join(env?.GIT_OBJECT_DIRECTORY ?? '', GIT_OBJECT_QUARANTINE_OWNER_FILE),
          'utf8'
        )
      )
    })

    expect(owner).toMatchObject({
      pid: process.pid,
      hostname: hostname(),
      platform: process.platform
    })
  })

  describe('stale scratch sweep', () => {
    const HOUR = 60 * 60 * 1000
    const self = (): GitObjectQuarantineOwner => gitObjectQuarantineOwner()
    const scratch = (name: string): string =>
      join(objects, `${GIT_OBJECT_QUARANTINE_DIR_PREFIX}${name}`)
    const makeScratch = (
      name: string,
      ageMs: number,
      owner?: GitObjectQuarantineOwner | string
    ) => {
      const dir = scratch(name)
      mkdirSync(dir)
      if (owner !== undefined) {
        writeFileSync(
          join(dir, GIT_OBJECT_QUARANTINE_OWNER_FILE),
          typeof owner === 'string' ? owner : JSON.stringify(owner)
        )
      }
      const modified = (Date.now() - ageMs) / 1000
      utimesSync(dir, modified, modified)
      return dir
    }

    beforeEach(() => {
      vi.spyOn(process, 'kill').mockImplementation((pid) => {
        const code = pid === EXITED_PID ? 'ESRCH' : pid === OTHER_USER_PID ? 'EPERM' : undefined
        if (code) {
          throw Object.assign(new Error(`kill ${code}`), { code })
        }
        return true
      })
    })

    const exited = (): GitObjectQuarantineOwner => ({ ...self(), pid: EXITED_PID })
    const elsewhere = (): GitObjectQuarantineOwner => ({ ...self(), hostname: `not-${hostname()}` })
    // Why the other platform: a WSL distro reports the Windows hostname but has its own pids.
    const otherPidSpace = (): GitObjectQuarantineOwner => ({
      ...exited(),
      platform: process.platform === 'win32' ? 'linux' : 'win32'
    })
    const pastGitExpiry = MAX_GIT_OBJECT_QUARANTINE_AGE_MS + HOUR

    it.each<[string, boolean, number, () => GitObjectQuarantineOwner | string | undefined]>([
      ['its owner on this host has exited', true, 2 * HOUR, exited],
      ['its owner is this process', false, 2 * HOUR, self],
      ['its owner on this host looks alive but it is 15 days old', true, 15 * 24 * HOUR, self],
      [
        'its owner runs as another user',
        false,
        2 * HOUR,
        () => ({ ...self(), pid: OTHER_USER_PID })
      ],
      ['its owner exited under an hour ago', false, STALE_GIT_OBJECT_QUARANTINE_AGE_MS / 2, exited],
      [
        'its owner is on another host',
        false,
        2 * 24 * HOUR,
        () => ({ ...elsewhere(), pid: EXITED_PID })
      ],
      ['its owner shares the hostname but not the pid space', false, 2 * 24 * HOUR, otherPidSpace],
      ['its owner is on another host and Git would expire it', true, pastGitExpiry, elsewhere],
      ['it has no owner record', false, 2 * 24 * HOUR, () => undefined],
      ['its owner record is unreadable', false, 2 * 24 * HOUR, () => '{"pid":'],
      ['it has no owner record and Git would expire it', true, pastGitExpiry, () => undefined]
    ])('when %s, removes it: %s', async (_label, removed, ageMs, owner) => {
      const dir = makeScratch('candidate', ageMs, owner())

      await createGitObjectQuarantine(resolveNative()).run(async () => {})

      expect(existsSync(dir)).toBe(!removed)
    })

    it('sweeps once per objects dir and never touches Git’s own quarantine dirs', async () => {
      const gitOwn = join(objects, 'tmp_objdir-incoming-old')
      mkdirSync(gitOwn)
      const old = (Date.now() - MAX_GIT_OBJECT_QUARANTINE_AGE_MS - HOUR) / 1000
      utimesSync(gitOwn, old, old)
      const stranded = makeScratch('stranded', 2 * HOUR, exited())

      await createGitObjectQuarantine(resolveNative()).run(async () => {})

      expect(existsSync(stranded)).toBe(false)
      expect(existsSync(gitOwn)).toBe(true)

      makeScratch('stranded', 2 * HOUR, exited())
      await createGitObjectQuarantine(resolveNative()).run(async () => {})
      expect(existsSync(stranded)).toBe(true)
    })
  })
})
