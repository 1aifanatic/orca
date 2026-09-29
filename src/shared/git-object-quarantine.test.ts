import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetGitObjectQuarantineSweepForTests,
  createGitObjectQuarantine,
  GIT_OBJECT_QUARANTINE_DIR_PREFIX,
  STALE_GIT_OBJECT_QUARANTINE_AGE_MS,
  type GitObjectQuarantineEnv
} from './git-object-quarantine'

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
    ['C:\\repo\\.git\\objects', 'C:\\repo\\.git\\objects']
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

  it('removes scratch dirs a crash stranded, once per objects dir, leaving recent ones and Git’s own', async () => {
    const stale = join(objects, `${GIT_OBJECT_QUARANTINE_DIR_PREFIX}stale`)
    const recent = join(objects, `${GIT_OBJECT_QUARANTINE_DIR_PREFIX}recent`)
    const gitOwn = join(objects, 'tmp_objdir-incoming-old')
    for (const dir of [stale, recent, gitOwn]) {
      mkdirSync(dir)
    }
    const old = (Date.now() - STALE_GIT_OBJECT_QUARANTINE_AGE_MS - 60_000) / 1000
    utimesSync(stale, old, old)
    utimesSync(gitOwn, old, old)

    const quarantine = createGitObjectQuarantine(resolveNative())
    await quarantine.run(async () => {})

    expect(existsSync(stale)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(gitOwn)).toBe(true)

    mkdirSync(stale)
    utimesSync(stale, old, old)
    await createGitObjectQuarantine(resolveNative()).run(async () => {})
    expect(existsSync(stale)).toBe(true)
  })
})
