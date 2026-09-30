import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Runner from '../runner'
import type * as Wsl from '../../wsl'
import type * as FileValidation from './worktree-membership-file-validation'

const runnerSpy = vi.hoisted(() => {
  const calls: string[][] = []
  return { calls, failWorktreeList: false }
})
vi.mock('../runner', async (importOriginal) => {
  const actual = await importOriginal<typeof Runner>()
  return {
    ...actual,
    gitExecFileAsync: (args: string[], options: Parameters<typeof actual.gitExecFileAsync>[1]) => {
      runnerSpy.calls.push(args)
      if (runnerSpy.failWorktreeList && args[0] === 'worktree' && args[1] === 'list') {
        return Promise.reject(new Error('fatal: unable to read worktrees'))
      }
      return actual.gitExecFileAsync(args, options)
    }
  }
})

type HeldRead = { entered: () => void; release: Promise<void> }
const validationGate = vi.hoisted(() => {
  const gate: {
    entered: (() => void) | null
    release: Promise<void> | null
    /** Each validation takes the next hold after reading, so it commits what it read before. */
    afterRead: HeldRead[]
    transientFailures: number
  } = { entered: null, release: null, afterRead: [], transientFailures: 0 }
  return gate
})
vi.mock('./worktree-membership-file-validation', async (importOriginal) => {
  const actual = await importOriginal<typeof FileValidation>()
  const { WorktreeRowsNeedGit } = await import('./worktree-membership-file-rows')
  return {
    validateMembershipFromFiles: async (
      input: Parameters<typeof actual.validateMembershipFromFiles>[0]
    ) => {
      validationGate.entered?.()
      await validationGate.release
      if (validationGate.transientFailures > 0) {
        validationGate.transientFailures -= 1
        throw new WorktreeRowsNeedGit('unreadable worktrees dir', true)
      }
      const result = await actual.validateMembershipFromFiles(input)
      const hold = validationGate.afterRead.shift()
      if (hold) {
        hold.entered()
        await hold.release
      }
      return result
    }
  }
})

/** Holds the next validation after it read the admin files, until `release`. */
function holdNextValidation(): { entered: Promise<void>; release: () => void } {
  let entered = (): void => {}
  let release = (): void => {}
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve
  })
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve
  })
  validationGate.afterRead.push({ entered, release: releasePromise })
  return { entered: enteredPromise, release }
}

const wslPaths = vi.hoisted(() => new Set<string>())
vi.mock('../../wsl', async (importOriginal) => {
  const actual = await importOriginal<typeof Wsl>()
  return {
    ...actual,
    parseWslPath: (path: string) =>
      wslPaths.has(path) ? { distro: 'Ubuntu', linuxPath: path } : actual.parseWslPath(path)
  }
})

import { clearGitCapabilityStateForTests } from '../git-capability-state'
import {
  listWorktrees,
  listWorktreesSharedStrict,
  listWorktreesSharedStrictAllowingTrueEmpty,
  _resetWorktreeScanCacheForTests,
  bumpWorktreeScanGeneration
} from '../worktree-scan-cache'
import { adminEntryKey } from './worktree-admin-file-reads'
import {
  LISTING_MEMBERSHIP_SCOPE,
  MEMBERSHIP_FULL_DERIVE_FLOOR_MS,
  MEMBERSHIP_IDLE_DROP_MS,
  MEMBERSHIP_READ_MEMO_MS
} from './worktree-membership-model'
import {
  _getWorktreeMembershipModelForTests,
  _resetWorktreeMembershipModelsForTests,
  isWorktreeMembershipModelBacked,
  markWorktreeMembershipCommonDirDirty,
  markWorktreeMembershipDirty,
  MissingRepoPathError,
  readWorktreeMembership,
  retainWorktreeMembershipModels
} from './worktree-membership-store'

const execFileAsync = promisify(execFile)

let scratchDir = ''
let repoPath = ''

async function git(args: string[], cwd = repoPath): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

function worktreeListSpawns(): number {
  return runnerSpy.calls.filter((args) => args[0] === 'worktree' && args[1] === 'list').length
}

async function commitIn(worktreePath: string, name: string): Promise<string> {
  await writeFile(join(worktreePath, `${name}.txt`), `${name}\n`)
  await git(['add', '-A'], worktreePath)
  await git(['commit', '-qm', name], worktreePath)
  return git(['rev-parse', 'HEAD'], worktreePath)
}

beforeEach(async () => {
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-membership-store-')))
  repoPath = join(scratchDir, 'repo')
  await mkdir(repoPath, { recursive: true })
  await git(['init', '-q', '-b', 'main'])
  await git(['config', 'user.email', 'membership@example.invalid'])
  await git(['config', 'user.name', 'Membership'])
  await commitIn(repoPath, 'seed')
  _resetWorktreeMembershipModelsForTests()
  _resetWorktreeScanCacheForTests()
  runnerSpy.calls.length = 0
  runnerSpy.failWorktreeList = false
  validationGate.entered = null
  validationGate.release = null
  validationGate.afterRead.length = 0
  validationGate.transientFailures = 0
  wslPaths.clear()
})

afterEach(async () => {
  vi.restoreAllMocks()
  _resetWorktreeMembershipModelsForTests()
  clearGitCapabilityStateForTests()
  await rm(scratchDir, { recursive: true, force: true })
})

describe('worktree membership model: spawns', () => {
  it('runs no git worktree list after the cold baseline, through a burst of changes', async () => {
    const linked = join(scratchDir, 'linked')
    await git(['worktree', 'add', '-q', linked, '-b', 'linked'])
    await listWorktreesSharedStrictAllowingTrueEmpty(repoPath)
    expect(worktreeListSpawns()).toBe(1)

    // A worktrees:changed burst: Orca's own mutation marks, watcher entry marks, and every reader.
    for (let round = 0; round < 5; round++) {
      const head = await commitIn(linked, `burst-${round}`)
      bumpWorktreeScanGeneration(repoPath)
      markWorktreeMembershipDirty(repoPath)
      markWorktreeMembershipCommonDirDirty(join(repoPath, '.git'), {
        all: false,
        listing: true,
        primary: false,
        entryKeys: new Set([adminEntryKey('linked')])
      })
      const [detected, lenient, strict] = await Promise.all([
        listWorktreesSharedStrictAllowingTrueEmpty(repoPath),
        listWorktrees(repoPath),
        listWorktreesSharedStrict(repoPath)
      ])
      for (const rows of [detected, lenient, strict]) {
        expect(rows.find((row) => row.path === linked)?.head).toBe(head)
      }
    }

    expect(worktreeListSpawns()).toBe(1)
  })

  it('answers a missing repo with one stat and no git', async () => {
    const missing = join(scratchDir, 'deleted-repo')
    await expect(readWorktreeMembership(missing)).rejects.toBeInstanceOf(MissingRepoPathError)
    await expect(listWorktrees(missing)).resolves.toEqual([])
    await expect(listWorktreesSharedStrictAllowingTrueEmpty(missing)).resolves.toEqual([])
    await expect(listWorktreesSharedStrict(missing)).rejects.toBeInstanceOf(MissingRepoPathError)
    expect(runnerSpy.calls).toEqual([])
  })
})

describe('worktree membership model: layouts', () => {
  it('leaves a WSL path to Git even when the caller names no distro', async () => {
    wslPaths.add(repoPath)
    await readWorktreeMembership(repoPath)
    expect(_getWorktreeMembershipModelForTests(repoPath)?.source).toEqual({
      kind: 'git',
      reason: 'WSL repo'
    })
  })
})

describe('worktree membership model: failure contracts', () => {
  it('keeps lenient, strict and true-empty apart for a Git failure', async () => {
    runnerSpy.failWorktreeList = true
    await expect(listWorktrees(repoPath)).resolves.toEqual([])
    await expect(listWorktreesSharedStrict(repoPath)).rejects.toThrow('unable to read worktrees')
    await expect(listWorktreesSharedStrictAllowingTrueEmpty(repoPath)).rejects.toThrow(
      'unable to read worktrees'
    )
    // A failed baseline builds no model, so the next read tries again.
    expect(isWorktreeMembershipModelBacked(repoPath)).toBe(false)
  })

  it('answers a folder that is not a Git repo as a true empty', async () => {
    const plain = join(scratchDir, 'plain-folder')
    await mkdir(plain)
    await expect(listWorktrees(plain)).resolves.toEqual([])
    await expect(listWorktreesSharedStrictAllowingTrueEmpty(plain)).resolves.toEqual([])
    await expect(listWorktreesSharedStrict(plain)).rejects.toThrow(/not a git repository/i)
  })
})

describe('worktree membership model: freshness', () => {
  it('serves the memo inside a second, then sees an unreported change by stat', async () => {
    const linked = join(scratchDir, 'linked')
    await git(['worktree', 'add', '-q', linked, '-b', 'linked'])
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const before = (await readWorktreeMembership(repoPath)).rows
    const head = await commitIn(linked, 'unreported')

    const memo = (await readWorktreeMembership(repoPath)).rows
    expect(memo).toBe(before)

    now += 1_000
    const after = (await readWorktreeMembership(repoPath)).rows
    expect(after.find((row) => row.path === linked)?.head).toBe(head)
  })

  it('never serves the memo to a reader that arrives while a change is being re-read', async () => {
    const linked = join(scratchDir, 'linked')
    await git(['worktree', 'add', '-q', linked, '-b', 'linked'])
    vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    await readWorktreeMembership(repoPath)
    const head = await commitIn(linked, 'concurrent')
    markWorktreeMembershipDirty(repoPath)
    const reads = await Promise.all([
      readWorktreeMembership(repoPath),
      readWorktreeMembership(repoPath),
      readWorktreeMembership(repoPath)
    ])
    for (const { rows } of reads) {
      expect(rows.find((row) => row.path === linked)?.head).toBe(head)
    }
  })

  it('lets a fresh read bypass the memo', async () => {
    const linked = join(scratchDir, 'linked')
    await git(['worktree', 'add', '-q', linked, '-b', 'linked'])
    vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    await readWorktreeMembership(repoPath)
    const head = await commitIn(linked, 'fresh')
    const { rows } = await readWorktreeMembership(repoPath, { fresh: true })
    expect(rows.find((row) => row.path === linked)?.head).toBe(head)
  })

  it('does not lose a change marked while a derivation is running', async () => {
    await readWorktreeMembership(repoPath)
    const model = _getWorktreeMembershipModelForTests(repoPath)!
    let release = (): void => {}
    validationGate.release = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      validationGate.entered = resolve
    })
    const running = readWorktreeMembership(repoPath, { fresh: true })
    await entered
    markWorktreeMembershipDirty(repoPath)
    validationGate.release = null
    release()
    await running
    expect(model.dirty.listing).toBe(true)

    const linked = join(scratchDir, 'late')
    await git(['worktree', 'add', '-q', linked, '-b', 'late'])
    const { rows } = await readWorktreeMembership(repoPath)
    expect(rows.map((row) => row.path)).toContain(linked)
  })

  it('never lets a derivation that predates a mark re-open the memo', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await readWorktreeMembership(repoPath)
    now += MEMBERSHIP_READ_MEMO_MS
    // A background read has read the admin files; then a create lands and Orca marks it.
    const olderHold = holdNextValidation()
    const older = readWorktreeMembership(repoPath)
    await olderHold.entered
    const created = join(scratchDir, 'created')
    await git(['worktree', 'add', '-q', created, '-b', 'created'])
    markWorktreeMembershipDirty(repoPath)
    const newerHold = holdNextValidation()
    const newer = readWorktreeMembership(repoPath)
    await newerHold.entered

    // The older derivation commits first; a reader after the mark must still see the create.
    olderHold.release()
    expect((await older).rows.map((row) => row.path)).not.toContain(created)
    const afterMark = readWorktreeMembership(repoPath)
    newerHold.release()
    expect((await newer).rows.map((row) => row.path)).toContain(created)
    expect((await afterMark).rows.map((row) => row.path)).toContain(created)
  })

  it('keeps a mark that lands while the model is first built', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const coldHold = holdNextValidation()
    const cold = readWorktreeMembership(repoPath)
    await coldHold.entered
    const created = join(scratchDir, 'created')
    await git(['worktree', 'add', '-q', created, '-b', 'created'])
    markWorktreeMembershipDirty(repoPath)
    coldHold.release()
    await cold
    now += 100
    const { rows } = await readWorktreeMembership(repoPath)
    expect(rows.map((row) => row.path)).toContain(created)
  })

  it('compares file rows with Git once a cold build fell back on a transient read failure', async () => {
    const linked = join(scratchDir, 'linked')
    await git(['worktree', 'add', '-q', linked, '-b', 'linked'])
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    validationGate.transientFailures = 1
    await readWorktreeMembership(repoPath)
    const model = _getWorktreeMembershipModelForTests(repoPath)!
    expect(model.files).toBeNull()
    const coldListings = worktreeListSpawns()

    now += MEMBERSHIP_READ_MEMO_MS
    const { rows } = await readWorktreeMembership(repoPath)
    // The parity baseline: file rows are adopted only once Git agreed with them.
    expect(worktreeListSpawns()).toBe(coldListings + 1)
    expect(model.files).not.toBeNull()
    expect(rows.map((row) => row.path)).toContain(linked)
  })

  it('lets a watcher mark reach a repo registered through a symlink', async () => {
    const registered = join(scratchDir, 'repo-link')
    await symlink(repoPath, registered, 'dir')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    await readWorktreeMembership(registered)
    const created = join(scratchDir, 'created')
    await git(['worktree', 'add', '-q', created, '-b', 'created'])
    // What the watcher passes: the common dir's realpath.
    markWorktreeMembershipCommonDirDirty(join(repoPath, '.git'), LISTING_MEMBERSHIP_SCOPE)
    const { rows } = await readWorktreeMembership(registered)
    expect(rows.map((row) => row.path)).toContain(created)
  })

  it("marks every registered repo that shares the changed repo's common dir", async () => {
    const linked = join(scratchDir, 'linked')
    await git(['worktree', 'add', '-q', linked, '-b', 'linked'])
    vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    await Promise.all([readWorktreeMembership(repoPath), readWorktreeMembership(linked)])
    const created = join(scratchDir, 'created')
    await git(['worktree', 'add', '-q', created, '-b', 'created'])
    markWorktreeMembershipDirty(repoPath)
    const { rows } = await readWorktreeMembership(linked)
    expect(rows.map((row) => row.path)).toContain(created)
  })

  it('re-reads every entry once the floor is due', async () => {
    const linked = join(scratchDir, 'linked')
    await git(['worktree', 'add', '-q', linked, '-b', 'linked'])
    await readWorktreeMembership(repoPath)
    await readWorktreeMembership(repoPath, { fresh: true })
    const model = _getWorktreeMembershipModelForTests(repoPath)!
    const settled = model.files!.entries.get('linked')
    await readWorktreeMembership(repoPath, { fresh: true })
    expect(model.files!.entries.get('linked')).toBe(settled)

    model.fullDerivedAt -= MEMBERSHIP_FULL_DERIVE_FLOOR_MS
    await readWorktreeMembership(repoPath, { fresh: true })
    expect(model.files!.entries.get('linked')).not.toBe(settled)
  })

  it('re-reads only the entry a scope names', async () => {
    await git(['worktree', 'add', '-q', join(scratchDir, 'a'), '-b', 'a'])
    await git(['worktree', 'add', '-q', join(scratchDir, 'b'), '-b', 'b'])
    await readWorktreeMembership(repoPath)
    await readWorktreeMembership(repoPath, { fresh: true })
    const model = _getWorktreeMembershipModelForTests(repoPath)!
    const [a, b] = [model.files!.entries.get('a'), model.files!.entries.get('b')]

    markWorktreeMembershipCommonDirDirty(join(repoPath, '.git'), {
      all: false,
      listing: false,
      primary: false,
      entryKeys: new Set([adminEntryKey('b')])
    })
    await readWorktreeMembership(repoPath)
    expect(model.files!.entries.get('a')).toBe(a)
    expect(model.files!.entries.get('b')).not.toBe(b)
  })
})

describe('worktree membership model: lifetime', () => {
  it('drops a model whose repo is no longer registered', async () => {
    await readWorktreeMembership(repoPath)
    retainWorktreeMembershipModels([repoPath])
    expect(isWorktreeMembershipModelBacked(repoPath)).toBe(true)
    retainWorktreeMembershipModels([])
    expect(isWorktreeMembershipModelBacked(repoPath)).toBe(false)
  })

  it('drops a model nobody read for the idle window', async () => {
    const other = join(scratchDir, 'other')
    await mkdir(other)
    await git(['init', '-q', '-b', 'main'], other)
    await readWorktreeMembership(repoPath)
    const now = Date.now() + MEMBERSHIP_IDLE_DROP_MS
    vi.spyOn(Date, 'now').mockReturnValue(now)
    await readWorktreeMembership(other)
    expect(isWorktreeMembershipModelBacked(repoPath)).toBe(false)
    expect(isWorktreeMembershipModelBacked(other)).toBe(true)
  })
})
