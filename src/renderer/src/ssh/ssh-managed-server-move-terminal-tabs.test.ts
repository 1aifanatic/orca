import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshManagedServerMoveResult } from '../../../shared/ssh-managed-server-move'
import { createTestStore, makeLayout, makeTab } from '../store/slices/store-test-helpers'

const store = createTestStore()
vi.mock('@/store', () => ({ useAppStore: store }))

const { collectSshTargetTerminalBindings, moveKeepingTerminalTabs } =
  await import('./ssh-managed-server-move-terminal-tabs')

const worktreeId = 'repo-1::/root/repo'
const shellOne = 'ssh:ssh-1@@pty-1'
const shellTwo = 'ssh:ssh-1@@pty-2'
const otherHostShell = 'ssh:ssh-9@@pty-1'

beforeEach(() => {
  store.setState({
    tabsByWorktree: {
      [worktreeId]: [
        makeTab({ id: 'tab-1', worktreeId, ptyId: shellOne }),
        makeTab({ id: 'tab-2', worktreeId, title: 'Terminal 2', ptyId: null }),
        makeTab({ id: 'tab-3', worktreeId, ptyId: otherHostShell })
      ]
    },
    ptyIdsByTabId: { 'tab-1': [shellOne], 'tab-3': [otherHostShell] },
    // A tab whose binding was already cleared by the disconnect still names its shell in its layout.
    terminalLayoutsByTabId: {
      'tab-2': { ...makeLayout(), ptyIdsByLeafId: { 'leaf-2': shellTwo } }
    },
    suppressedPtyExitIds: {}
  })
})

/** Delivers a shell's exit the way every pane and tab exit handler does: suppression first. */
function deliverExit(ptyId: string): boolean {
  return store.getState().consumeSuppressedPtyExit(ptyId)
}

describe('moving a host keeps its terminal tabs', () => {
  it("finds every shell this host's tabs are bound to, and no other host's", () => {
    expect(collectSshTargetTerminalBindings(store.getState(), 'ssh-1')).toEqual([
      { tabId: 'tab-1', ptyId: shellOne },
      { tabId: 'tab-2', ptyId: shellTwo }
    ])
  })

  it("does not let the stopped shells' exits close their tabs once the host moved", async () => {
    let keptDuringMove: boolean[] = []
    const result = await moveKeepingTerminalTabs('ssh-1', async () => {
      keptDuringMove = [deliverExit(shellOne), deliverExit(otherHostShell)]
      return { outcome: 'moved', environmentId: 'env-1' }
    })
    expect(result.outcome).toBe('moved')
    expect(keptDuringMove).toEqual([true, false])
    // A late exit for a shell the server now owns must not close the row it took over.
    expect(deliverExit(shellTwo)).toBe(true)
  })

  it.each<SshManagedServerMoveResult>([
    { outcome: 'refused', verdict: 'unverifiable', terminals: 1 },
    { outcome: 'stayed' }
  ])('restarts a stopped shell on the relay when the host stays ($outcome)', async (outcome) => {
    const remount = vi.fn()
    store.setState({ remountTerminalTabForRecovery: remount })
    await moveKeepingTerminalTabs('ssh-1', async () => {
      deliverExit(shellOne)
      return outcome
    })
    expect(remount.mock.calls.map(([tabId]) => tabId)).toEqual(['tab-1'])
    // A shell whose exit never came may still run, so its real exit is handled normally again.
    expect(store.getState().suppressedPtyExitIds[shellTwo]).toBeUndefined()
  })

  it('releases the suppressions when the move fails outright', async () => {
    await expect(
      moveKeepingTerminalTabs('ssh-1', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(store.getState().suppressedPtyExitIds).toEqual({})
  })
})
