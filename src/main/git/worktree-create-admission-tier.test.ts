import { beforeEach, describe, expect, it, vi } from 'vitest'

type GitExec = (
  args: string[],
  options: Record<string, unknown>
) => Promise<{ stdout: string; stderr: string }>

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn<GitExec>())

vi.mock('./runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

// These cases pin the listing layer over a mocked Git with made-up paths, so reads take the
// Git-answered path the membership model keeps for layouts it cannot read from files.
vi.mock('./worktree-membership/worktree-membership-store', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const reader = await import('./worktree-list-reader')
  return {
    ...actual,
    readWorktreeMembership: async (repoPath: string, options: Record<string, unknown> = {}) => ({
      rows: await reader.readTranslatedWorktreeGraph(repoPath, options),
      fromModel: false
    })
  }
})

import { addWorktree } from './worktree-add'
import { listWorktreesSharedStrict } from './worktree-scan-cache'

const HEAD = 'a'.repeat(40)

/** Options every call to `git` carried, keyed by the subcommand the args name. */
function optionsForCommand(match: string): Record<string, unknown>[] {
  return gitExecFileAsyncMock.mock.calls
    .filter((call) => call[0].join(' ').includes(match))
    .map((call) => call[1])
}

describe('worktree create admission tier', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset().mockResolvedValue({ stdout: HEAD, stderr: '' })
  })

  it('runs the create add at the tier the caller asked for', async () => {
    await addWorktree('/repo', '/repo-wt', 'feature', 'main', false, false, {
      admissionTier: 'interactive'
    })

    const addOptions = optionsForCommand('worktree add')
    expect(addOptions).toHaveLength(1)
    expect(addOptions[0]).toMatchObject({
      cwd: '/repo',
      admissionTier: 'interactive'
    })
  })

  it('runs the post-add listing at the tier the caller asked for', async () => {
    await listWorktreesSharedStrict('/repo', { admissionTier: 'interactive' })

    const listOptions = optionsForCommand('worktree list')
    expect(listOptions.length).toBeGreaterThan(0)
    for (const options of listOptions) {
      expect(options).toMatchObject({ admissionTier: 'interactive' })
    }
  })

  it('leaves a command with no tier at the scheduler default', async () => {
    await addWorktree('/repo', '/repo-wt', 'feature', 'main')

    expect(optionsForCommand('worktree add')[0]).not.toHaveProperty('admissionTier')
  })
})
