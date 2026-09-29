import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from './git/runner'
import type * as GitRunner from './git/runner'
import {
  _resetLocalWorktreeCreateActivityForTests,
  holdLocalWorktreeCreate
} from './git/local-worktree-create-activity'
import { sweepRetiredWorktreeCreatePreparations } from './retired-worktree-create-preparation-sweep'

vi.mock('./git/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRunner>()
  return { ...actual, gitExecFileAsync: vi.fn(actual.gitExecFileAsync) }
})

const DEAD_PID = 999_991
const LIVE_PID = 999_992
const roots: string[] = []

afterEach(async () => {
  _resetLocalWorktreeCreateActivityForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function spareName(pid: number, suffix: string): string {
  return `${pid}-${suffix}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
}

async function makeRoot(): Promise<string> {
  // Git reports resolved paths, and macOS temp dirs sit behind a symlink.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-retired-spares-')))
  roots.push(root)
  return root
}

async function makeRepo(root: string, name: string): Promise<string> {
  const repo = join(root, name)
  await gitExecFileAsync(['init', '--quiet', repo], { cwd: root })
  await gitExecFileAsync(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo })
  await writeFile(join(repo, 'file.txt'), 'content\n')
  await writeFile(join(repo, 'other.txt'), 'other\n')
  await gitExecFileAsync(['add', '.'], { cwd: repo })
  await gitExecFileAsync(
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'],
    { cwd: repo }
  )
  return repo
}

async function addSpare(
  repo: string,
  path: string,
  options: { lockPid?: number; noCheckout?: boolean } = {}
): Promise<void> {
  await gitExecFileAsync(
    ['worktree', 'add', '--detach', ...(options.noCheckout ? ['--no-checkout'] : []), path, 'main'],
    { cwd: repo }
  )
  if (options.lockPid !== undefined) {
    await lock(repo, path, `orca-create-preparation:v1:${options.lockPid}:session`)
  }
}

async function lock(repo: string, path: string, reason: string): Promise<void> {
  await gitExecFileAsync(['worktree', 'lock', '--reason', reason, path], { cwd: repo })
}

async function registrations(repo: string): Promise<Map<string, string>> {
  const { stdout } = await gitExecFileAsync(['worktree', 'list', '--porcelain'], { cwd: repo })
  const locks = new Map<string, string>()
  for (const block of stdout.trim().split('\n\n')) {
    const path = /^worktree (.+)$/m.exec(block)?.[1] ?? ''
    locks.set(path, /^locked ?(.*)$/m.exec(block)?.[1] ?? 'unlocked')
  }
  return locks
}

function sweepGitCalls(): string[][] {
  return vi.mocked(gitExecFileAsync).mock.calls.map(([args]) => args)
}

it('reclaims spares left by dead Orca processes and leaves everything else alone', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  const workspaceRoot = join(root, 'workspaces')
  const spares = join(workspaceRoot, '.orca-preparing')
  const deadSpare = join(spares, spareName(DEAD_PID, '11111111'))
  const liveSpare = join(spares, spareName(LIVE_PID, '22222222'))
  const orphanDirectory = join(spares, spareName(DEAD_PID, '33333333'))
  const userWorktree = join(workspaceRoot, 'feature')
  await addSpare(repo, deadSpare, { lockPid: DEAD_PID })
  await addSpare(repo, liveSpare, { lockPid: LIVE_PID })
  await mkdir(orphanDirectory, { recursive: true })
  await writeFile(join(orphanDirectory, 'file.txt'), 'leftover\n')
  await gitExecFileAsync(['worktree', 'add', '-b', 'feature', userWorktree, 'main'], { cwd: repo })

  const result = await sweepRetiredWorktreeCreatePreparations(
    { workspaceRoots: [workspaceRoot], repos: [{ path: repo }] },
    { isProcessAlive: (pid) => pid === LIVE_PID }
  )

  expect(result).toEqual({ reclaimed: 1, removedDirectories: 1 })
  expect(existsSync(deadSpare)).toBe(false)
  expect(existsSync(orphanDirectory)).toBe(false)
  // A running older Orca still owns its spare, so the shared folder stays too.
  expect(existsSync(liveSpare)).toBe(true)
  expect(existsSync(userWorktree)).toBe(true)
  const paths = [...(await registrations(repo)).keys()]
  expect(paths).toContain(liveSpare)
  expect(paths).toContain(userWorktree)
  expect(paths).not.toContain(deadSpare)
})

it('reclaims every shape an older build could leave, in one launch and without a listing', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  const droppedRepo = await makeRepo(root, 'dropped-from-orca')
  const workspaceRoot = join(root, 'workspaces')
  const spares = join(workspaceRoot, '.orca-preparing')
  // Quit after `reset --hard`, before the lock: a clean, unlocked spare the sidebar lists.
  const unlockedSpare = join(spares, spareName(DEAD_PID, '11111111'))
  await addSpare(repo, unlockedSpare)
  // Quit mid `reset --hard`: no index yet, only some of HEAD's files written.
  const unfinishedSpare = join(spares, spareName(DEAD_PID, '22222222'))
  await addSpare(repo, unfinishedSpare, { noCheckout: true })
  await writeFile(join(unfinishedSpare, 'file.txt'), 'content\n')
  // A spare of a repo the user has since removed from Orca.
  const droppedRepoSpare = join(spares, spareName(DEAD_PID, '33333333'))
  await addSpare(droppedRepo, droppedRepoSpare, { lockPid: DEAD_PID })
  // Quit mid-delete: the directory lost its `.git` file but Git still has it locked.
  const halfDeletedSpare = join(spares, spareName(DEAD_PID, '44444444'))
  await addSpare(repo, halfDeletedSpare, { lockPid: DEAD_PID })
  await rm(join(halfDeletedSpare, '.git'))
  // The directory is gone entirely, or sits in a folder the settings no longer name.
  const vanishedSpare = join(
    root,
    'old-workspaces',
    '.orca-preparing',
    spareName(DEAD_PID, '55555555')
  )
  await addSpare(repo, vanishedSpare, { lockPid: DEAD_PID })
  await rm(vanishedSpare, { recursive: true, force: true })
  // Quit after the spare moved to the user's path, before (or after) `checkout -b`.
  const movedDetached = join(workspaceRoot, 'my-feature')
  await addSpare(repo, movedDetached, { lockPid: DEAD_PID })
  const movedBranched = join(workspaceRoot, 'my-branch')
  await gitExecFileAsync(['worktree', 'add', '-b', 'my-branch', movedBranched, 'main'], {
    cwd: repo
  })
  await lock(repo, movedBranched, `orca-create-preparation:v1:${DEAD_PID}:session`)
  vi.mocked(gitExecFileAsync).mockClear()

  const targets = { workspaceRoots: [workspaceRoot], repos: [{ path: repo }] }
  const dead = { isProcessAlive: () => false }
  const first = await sweepRetiredWorktreeCreatePreparations(targets, dead)

  expect(sweepGitCalls().some((args) => args.includes('list'))).toBe(false)
  expect(first).toEqual({ reclaimed: 7, removedDirectories: 1 })
  for (const path of [unlockedSpare, unfinishedSpare, droppedRepoSpare, halfDeletedSpare]) {
    expect(existsSync(path)).toBe(false)
  }
  expect(existsSync(spares)).toBe(false)
  const repoRegistrations = await registrations(repo)
  expect([...repoRegistrations.keys()].sort()).toEqual([movedBranched, movedDetached, repo].sort())
  // Moved spares are the user's worktrees now: kept, only no longer hidden.
  expect(repoRegistrations.get(movedDetached)).toBe('unlocked')
  expect(repoRegistrations.get(movedBranched)).toBe('unlocked')
  expect([...(await registrations(droppedRepo)).keys()]).toEqual([droppedRepo])
  expect(await sweepRetiredWorktreeCreatePreparations(targets, dead)).toEqual({
    reclaimed: 0,
    removedDirectories: 0
  })
})

it('keeps anything that may hold the user’s work', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  const workspaceRoot = join(root, 'workspaces')
  const spares = join(workspaceRoot, '.orca-preparing')
  // An unlocked spare shows in the sidebar, so the user may have worked in it.
  const editedSpare = join(spares, spareName(DEAD_PID, '11111111'))
  await addSpare(repo, editedSpare)
  await writeFile(join(editedSpare, 'file.txt'), 'user edit\n')
  const unfinishedWithUserFile = join(spares, spareName(DEAD_PID, '22222222'))
  await addSpare(repo, unfinishedWithUserFile, { noCheckout: true })
  await writeFile(join(unfinishedWithUserFile, 'notes.txt'), 'user notes\n')
  const userLockedSpare = join(spares, spareName(DEAD_PID, '33333333'))
  await addSpare(repo, userLockedSpare)
  await lock(repo, userLockedSpare, 'on a USB drive')
  const userDirectory = join(spares, 'notes')
  await mkdir(userDirectory)
  const userWorktree = join(workspaceRoot, 'feature')
  await gitExecFileAsync(['worktree', 'add', '-b', 'feature', userWorktree, 'main'], { cwd: repo })
  await lock(repo, userWorktree, 'on a USB drive')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  const result = await sweepRetiredWorktreeCreatePreparations(
    { workspaceRoots: [workspaceRoot], repos: [{ path: repo }] },
    { isProcessAlive: () => false }
  )

  expect(result).toEqual({ reclaimed: 0, removedDirectories: 0 })
  expect(await readFile(join(editedSpare, 'file.txt'), 'utf-8')).toBe('user edit\n')
  expect(await readFile(join(unfinishedWithUserFile, 'notes.txt'), 'utf-8')).toBe('user notes\n')
  expect(existsSync(userLockedSpare)).toBe(true)
  expect(existsSync(userDirectory)).toBe(true)
  const repoRegistrations = await registrations(repo)
  expect(repoRegistrations.get(editedSpare)).toBe('unlocked')
  expect(repoRegistrations.get(unfinishedWithUserFile)).toBe('unlocked')
  expect(repoRegistrations.get(userLockedSpare)).toBe('on a USB drive')
  expect(repoRegistrations.get(userWorktree)).toBe('on a USB drive')
  warn.mockRestore()
})

it('spawns no Git once nothing is left over', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  const workspaceRoot = join(root, 'workspaces')
  await gitExecFileAsync(['worktree', 'add', '-b', 'feature', join(workspaceRoot, 'f'), 'main'], {
    cwd: repo
  })
  vi.mocked(gitExecFileAsync).mockClear()

  const result = await sweepRetiredWorktreeCreatePreparations(
    { workspaceRoots: [workspaceRoot], repos: [{ path: repo }] },
    { isProcessAlive: () => false }
  )

  expect(result).toEqual({ reclaimed: 0, removedDirectories: 0 })
  expect(sweepGitCalls()).toEqual([])
})

it('treats a spare naming this process as an older Orca whose pid was reused', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  const workspaceRoot = join(root, 'workspaces')
  const spare = join(workspaceRoot, '.orca-preparing', spareName(process.pid, '11111111'))
  await addSpare(repo, spare, { lockPid: process.pid })

  const result = await sweepRetiredWorktreeCreatePreparations(
    { workspaceRoots: [workspaceRoot], repos: [{ path: repo }] },
    { isProcessAlive: () => true }
  )

  expect(result).toEqual({ reclaimed: 1, removedDirectories: 0 })
  expect(existsSync(spare)).toBe(false)
})

it('waits for a local create to finish before reclaiming anything', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  const workspaceRoot = join(root, 'workspaces')
  const spare = join(workspaceRoot, '.orca-preparing', spareName(DEAD_PID, '11111111'))
  await addSpare(repo, spare, { lockPid: DEAD_PID })
  const release = holdLocalWorktreeCreate()
  vi.mocked(gitExecFileAsync).mockClear()

  const sweep = sweepRetiredWorktreeCreatePreparations(
    { workspaceRoots: [workspaceRoot], repos: [{ path: repo }] },
    { isProcessAlive: () => false }
  )
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(sweepGitCalls()).toEqual([])
  expect(existsSync(spare)).toBe(true)
  release()

  expect(await sweep).toEqual({ reclaimed: 1, removedDirectories: 0 })
  expect(existsSync(spare)).toBe(false)
})
