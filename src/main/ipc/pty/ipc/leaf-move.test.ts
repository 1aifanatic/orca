import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentHookServer } from '../../../agent-hooks/server'
import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { TerminalLeafMoveResult } from '../../../../shared/terminal-leaf-move'
import { setPtyHostBindings } from '../../pty-host-bindings'
import { commitLeafMoveAndRekey, installPtyLeafMoveIpcHandler } from './leaf-move'

const LEAF = '22222222-2222-4222-8222-222222222222'
const request = {
  worktreeId: 'repo-1::/tmp/wt',
  sourceTabId: 'tab-source',
  targetTabId: 'tab-target',
  leafId: LEAF,
  ptyId: 'pty-agent'
}

function deps(result: TerminalLeafMoveResult, homeHostId: string | null = 'ssh:target-1') {
  const rekeyWorkerTerminalResourcePaneKey = vi.fn(() => 1)
  const moveTerminalLeafToNewTab = vi.fn(async () => result)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the move reads only this Store method.
  const store = { moveTerminalLeafToNewTab } as unknown as Store
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the move reads only the home resolver and the orchestration DB accessor.
  const runtime = {
    getTerminalTopologyHomeHostId: () => homeHostId,
    getExistingOrchestrationDb: () => ({ rekeyWorkerTerminalResourcePaneKey })
  } as unknown as OrcaRuntimeService
  return { store, runtime, rekeyWorkerTerminalResourcePaneKey, moveTerminalLeafToNewTab }
}

afterEach(() => {
  vi.restoreAllMocks()
  setPtyHostBindings({})
})

describe('pty:moveLeafToNewTab', () => {
  it('aliases agent status and re-keys worker resources after a committed move', async () => {
    const transfer = vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})
    const { store, runtime, rekeyWorkerTerminalResourcePaneKey } = deps({
      status: 'moved',
      ptyId: 'pty-agent'
    })

    await expect(commitLeafMoveAndRekey({ store, runtime }, request)).resolves.toEqual({
      status: 'moved',
      ptyId: 'pty-agent'
    })

    expect(transfer).toHaveBeenCalledWith(
      `tab-source:${LEAF}`,
      `tab-target:${LEAF}`,
      'pty-agent',
      expect.any(Number),
      { authorityVerified: true }
    )
    expect(rekeyWorkerTerminalResourcePaneKey).toHaveBeenCalledWith({
      fromPaneKey: `tab-source:${LEAF}`,
      toPaneKey: `tab-target:${LEAF}`
    })
  })

  it.each<TerminalLeafMoveResult>([
    { status: 'not_held' },
    { status: 'refused', reason: 'pty_mismatch' }
  ])('leaves every pane key alone when the move did not commit (%o)', async (result) => {
    const transfer = vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})
    const { store, runtime, rekeyWorkerTerminalResourcePaneKey } = deps(result)

    await expect(commitLeafMoveAndRekey({ store, runtime }, request)).resolves.toEqual(result)

    expect(transfer).not.toHaveBeenCalled()
    expect(rekeyWorkerTerminalResourcePaneKey).not.toHaveBeenCalled()
  })

  it("writes only the worktree's home partition", async () => {
    vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})
    const { store, runtime, moveTerminalLeafToNewTab } = deps({ status: 'moved', ptyId: null })

    await commitLeafMoveAndRekey({ store, runtime }, request)

    expect(moveTerminalLeafToNewTab).toHaveBeenCalledExactlyOnceWith(request, 'ssh:target-1')
  })

  it('writes nothing when the home is unresolved', async () => {
    const { store, runtime, moveTerminalLeafToNewTab } = deps(
      { status: 'moved', ptyId: null },
      null
    )

    await expect(commitLeafMoveAndRekey({ store, runtime }, request)).resolves.toEqual({
      status: 'refused',
      reason: 'home_unresolved'
    })
    expect(moveTerminalLeafToNewTab).not.toHaveBeenCalled()
  })

  it('replies with the publishSeq of the push that carries the move', async () => {
    vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})
    const handlers = new Map<string, (event: never, args: unknown) => unknown>()
    setPtyHostBindings({
      ipc: {
        handle: (channel, listener) => handlers.set(channel, listener),
        on: () => {},
        removeHandler: () => {},
        removeAllListeners: () => {}
      }
    })
    const { store, runtime } = deps({ status: 'moved', ptyId: 'pty-agent' })
    const settleTerminalTopology = vi.fn(() => 12)
    installPtyLeafMoveIpcHandler({
      store,
      runtime: Object.assign(runtime, { settleTerminalTopology })
    })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler never reads the IPC event.
    const reply = handlers.get('pty:moveLeafToNewTab')!({} as never, request)
    await expect(reply).resolves.toEqual({
      status: 'moved',
      ptyId: 'pty-agent',
      publishSeq: 12
    })
    expect(settleTerminalTopology).toHaveBeenCalledWith(request.worktreeId)
  })
})
