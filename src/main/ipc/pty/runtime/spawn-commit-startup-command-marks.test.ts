import { describe, expect, it, vi } from 'vitest'
import { toRuntimeSpawnReply } from './spawn'
import { commitRuntimePtySpawn } from './spawn-commit'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import type { PtyRuntimeControllerDeps } from './controller-deps'

function commitFresh(result: Record<string, unknown>) {
  const runtime = {
    registerPreAllocatedHandleForPty: vi.fn(),
    registerPty: vi.fn(),
    reflowHeadlessTerminalToPtyGrid: vi.fn(),
    seedHeadlessTerminal: vi.fn(),
    noteTerminalSpawnCommand: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the commit reaches only these runtime members for a fresh spawn.
  const deps = {
    runtime,
    store: undefined,
    options: {},
    sendPtySpawnedToRenderer: vi.fn()
  } as unknown as PtyRuntimeControllerDeps
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a fresh local spawn needs only its grid and worktree.
  const args = { cols: 120, rows: 40, worktreeId: 'wt-1' } as unknown as RuntimePtySpawnArgs
  const ctx = createRuntimePtySpawnState(deps, args)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a provider reply for a fresh spawn.
  ctx.result = { id: 'pty-marks', ...result } as unknown as typeof ctx.result
  return commitRuntimePtySpawn(ctx)
}

describe('runtime spawn commit: startup-command marks', () => {
  it("passes the provider's answer through to the runtime, true or false", async () => {
    for (const startupCommandMarked of [true, false]) {
      const committed = await commitFresh({ startupCommandMarked })
      expect(committed).toMatchObject({ startupCommandMarked })
      expect(toRuntimeSpawnReply(committed)).toMatchObject({ startupCommandMarked })
    }
  })

  it('leaves it out when the provider did not say (SSH, reattach)', async () => {
    const committed = await commitFresh({})
    expect(committed).not.toHaveProperty('startupCommandMarked')
    expect(toRuntimeSpawnReply(committed)).not.toHaveProperty('startupCommandMarked')
  })
})
