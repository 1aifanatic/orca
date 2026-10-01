import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakeGitScript,
  fakeGit,
  gitCommands,
  isPlainAdd,
  isRemove,
  OID_A,
  type FakeGitScript
} from '../worktree-create-spare-test-harness'
import type * as WorktreeBaseRefresh from './worktree-base-refresh'

const { gitExecFileAsyncMock, refreshMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  refreshMock: vi.fn(async () => undefined)
}))
vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: vi.fn(),
  translateWslOutputPaths: (output: string) => output
}))
vi.mock('./worktree-base-refresh', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeBaseRefresh>()),
  refreshLocalBaseRefForWorktreeCreate: refreshMock
}))

import { addWorktree } from './worktree-add'
import { runLocalWorktreeCreate } from './worktree-create-git-executor'
import { clearGitCapabilityStateForTests } from './git-capability-state'
import {
  _resetSparePoolForTests,
  findSpare,
  spareRepoKey,
  startSpare
} from '../worktree-create-preparation-pool'
import { _resetSpareGateForTests } from '../worktree-create-spare-gate'
import { _whenSpareDiscardsSettledForTests } from '../worktree-create-spare-discard'

let root = ''
let script: FakeGitScript

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-spare-handover-')))
  script = createFakeGitScript()
  script.refs.set('refs/remotes/origin/feature', OID_A)
  gitExecFileAsyncMock.mockImplementation(fakeGit(script))
  clearGitCapabilityStateForTests()
  refreshMock.mockClear()
})

afterEach(async () => {
  _resetSparePoolForTests()
  _resetSpareGateForTests()
  await rm(root, { recursive: true, force: true })
})

async function readySpare(): Promise<void> {
  startSpare({ repoPath: '/repo', workspaceRoot: root, oid: OID_A, hookRun: true, options: {} })
  await vi.waitFor(() => expect(findSpare(spareRepoKey('/repo'))?.state).toBe('ready'))
}

function create(branch: string, base = 'origin/feature', refresh = false) {
  return runLocalWorktreeCreate(() =>
    addWorktree('/repo', join(root, branch), branch, base, refresh, false, {
      remoteTrackingBase: { base, branch: base.split('/')[1] ?? base, ref: `refs/remotes/${base}` },
      preparedCheckout: { workspaceRoot: root }
    })
  )
}

it("skips the local base refresh when a spare create makes the base's own branch", async () => {
  await readySpare()
  expect((await create('feature', 'origin/feature', true)).preparedCheckout).toEqual({
    status: 'hit'
  })
  expect(refreshMock).not.toHaveBeenCalled()

  await readySpare()
  expect((await create('other', 'origin/feature', true)).preparedCheckout).toEqual({
    status: 'hit'
  })
  expect(refreshMock).toHaveBeenCalledTimes(1)
})

it('fails the create and keeps the worktree when post-checkout fails, as a plain add does', async () => {
  await readySpare()
  script.failing.add('hook')

  await expect(create('feature')).rejects.toThrow('hook failed')

  expect(gitCommands(script, (args) => args[1] === 'unlock')).toHaveLength(1)
  expect(gitCommands(script, isRemove)).toHaveLength(0)
  expect(gitCommands(script, isPlainAdd)).toHaveLength(0)
})

it('fails the create and leaves the target to background removal when the move back fails', async () => {
  await readySpare()
  script.failing.add('symbolic-ref')
  script.failing.add('move-back')

  await expect(create('feature')).rejects.toThrow('move failed')
  await _whenSpareDiscardsSettledForTests()

  expect(gitCommands(script, isRemove).map((call) => call.args.at(-1))).toEqual([
    join(root, 'feature')
  ])
  expect(gitCommands(script, isPlainAdd)).toHaveLength(0)
})
