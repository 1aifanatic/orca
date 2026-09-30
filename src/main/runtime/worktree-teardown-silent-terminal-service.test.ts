import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listRegisteredPtysMock } = vi.hoisted(() => ({ listRegisteredPtysMock: vi.fn() }))

vi.mock('../memory/pty-registry', () => ({ listRegisteredPtys: listRegisteredPtysMock }))

import { killAllProcessesForWorktree } from './worktree-teardown'
import { WORKTREE_TEARDOWN_FORCE_HINT } from '../../shared/worktree/removal'
import type { IPtyProvider } from '../providers/types'
import type { PtyProcessSourceListing } from '../providers/pty-process-source-listing'

const WORKTREE = 'repo::/tmp/wt'

/** Current version answers with `current`; version 35 is silent and was last known to hold `silent`. */
function providerWithSilentVersion(current: string[], silent: string[]): IPtyProvider {
  const listings: PtyProcessSourceListing[] = [
    {
      protocolVersion: 36,
      isCurrent: true,
      contact: 'live',
      processes: current.map((id) => ({ id, cwd: '', title: 'shell' }))
    },
    {
      protocolVersion: 35,
      isCurrent: false,
      contact: 'unverifiable',
      error: new Error('Request listSessions timed out'),
      lastKnownIds: silent
    }
  ]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown reads only these provider members.
  return {
    listProcessesBySource: vi.fn(async () => listings),
    listProcesses: vi.fn(async () => {
      throw new Error('Request listSessions timed out')
    }),
    // Why: the silent version never answers its stop; the current one does.
    shutdown: vi.fn(async (id: string) => {
      if (!current.includes(id)) {
        throw new Error('Request kill timed out')
      }
    }),
    confirmPtyStopped: vi.fn(async (id: string) => (current.includes(id) ? true : null)),
    onData: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {})
  } as unknown as IPtyProvider
}

describe('workspace delete while an older terminal service does not answer', () => {
  beforeEach(() => {
    listRegisteredPtysMock.mockReset().mockReturnValue([])
  })

  it('deletes and reports the unchecked version when it held no known terminal here', async () => {
    const provider = providerWithSilentVersion([`${WORKTREE}@@a`], ['repo::/tmp/other@@b'])

    const result = await killAllProcessesForWorktree(WORKTREE, {
      localProvider: provider,
      requirePhysicalStop: true,
      timeoutMs: 1_000
    })

    expect(result.providerStopped).toBe(1)
    expect(result.uncheckedTerminalServices).toEqual([{ protocolVersion: 35 }])
    expect(provider.shutdown).not.toHaveBeenCalledWith('repo::/tmp/other@@b', expect.anything())
  })

  it('refuses with the Force Delete hint when the silent version held a terminal of this workspace', async () => {
    const provider = providerWithSilentVersion([`${WORKTREE}@@a`], [`${WORKTREE}@@old`])

    await expect(
      killAllProcessesForWorktree(WORKTREE, {
        localProvider: provider,
        requirePhysicalStop: true,
        timeoutMs: 1_000
      })
    ).rejects.toThrow(WORKTREE_TEARDOWN_FORCE_HINT)
    expect(provider.shutdown).toHaveBeenCalledWith(`${WORKTREE}@@old`, expect.anything())
  })

  it('lets an explicit Force Delete through past that terminal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = providerWithSilentVersion([], [`${WORKTREE}@@old`])

    const result = await killAllProcessesForWorktree(WORKTREE, {
      localProvider: provider,
      requirePhysicalStop: true,
      allowUnverifiedStop: true,
      timeoutMs: 1_000
    })

    expect(result.providerStopped).toBe(0)
    warn.mockRestore()
  })
})
