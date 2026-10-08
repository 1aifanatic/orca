import '../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'
import { settleRemovalWithinWaitLimit } from './worktree-removal-wait'
import { classifyRuntimeLongPoll } from '../../runtime-rpc/runtime-rpc-long-poll'
import { WORKTREE_REMOVAL_WAIT_LIMIT_MS } from '../../../../shared/worktree/removal'

describe('a delete the caller waits for', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the local socket alive past its 30 s idle timer', () => {
    const request = (params: Record<string, unknown>) => ({
      id: 'req',
      authToken: 'tok',
      method: 'worktree.rm',
      params: { worktree: 'id:wt-1', ...params }
    })
    expect(classifyRuntimeLongPoll(request({ waitForRemoval: true }))).toBe('wait')
    expect(classifyRuntimeLongPoll(request({}))).toBeNull()
  })

  it('answers with the finished removal', async () => {
    await expect(settleRemovalWithinWaitLimit(Promise.resolve({}), 1_000)).resolves.toEqual({})
  })

  it('surfaces a failed removal as its real error', async () => {
    const failure = new Error('Failed to delete worktree at /tmp/wt-1. EBUSY')
    await expect(settleRemovalWithinWaitLimit(Promise.reject(failure), 1_000)).rejects.toBe(failure)
  })

  it('says the removal is unfinished, not removed, when the wait runs out', async () => {
    vi.useFakeTimers()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      removeManagedWorktree: vi.fn(() => new Promise(() => {}))
    }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktree.rm with an explicit host reads only removeManagedWorktree.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: WORKTREE_METHODS
    })

    const reply = dispatcher.dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'worktree.rm',
      params: { worktree: 'id:wt-1', hostId: 'local', waitForRemoval: true }
    })
    await vi.advanceTimersByTimeAsync(WORKTREE_REMOVAL_WAIT_LIMIT_MS)

    await expect(reply).resolves.toMatchObject({
      ok: true,
      result: { removed: false, removing: true, waitExpired: true }
    })
  })
})
