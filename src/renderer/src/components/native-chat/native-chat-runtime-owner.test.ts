import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  selectNativeChatBridgeMembership,
  selectNativeChatRuntimeEnvironmentId,
  type NativeChatRuntimeOwnerState
} from './native-chat-runtime-owner'

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

/** A worktree record with a host id but deliberately no `path` — the owner
 *  selector must not depend on path resolution (KTD-1). */
function worktreeRecord(hostId: string): NativeChatRuntimeOwnerState['worktreesByRepo'] {
  return { repo: [{ id: 'wt-1', repoId: 'repo', hostId } as never] }
}

function state(overrides: Partial<NativeChatRuntimeOwnerState> = {}): NativeChatRuntimeOwnerState {
  return {
    folderWorkspaces: [],
    projectGroups: [],
    repos: [],
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree: { 'wt-1': [terminalTab()] },
    worktreesByRepo: worktreeRecord('local'),
    ...overrides
  } as NativeChatRuntimeOwnerState
}

describe('selectNativeChatRuntimeEnvironmentId', () => {
  it('returns null for a local-owned worktree', () => {
    expect(selectNativeChatRuntimeEnvironmentId(state(), 'wt-1')).toBeNull()
  })

  it('returns the decoded environment id for a runtime-owned worktree', () => {
    expect(
      selectNativeChatRuntimeEnvironmentId(
        state({ worktreesByRepo: worktreeRecord('runtime:env-1') }),
        'wt-1'
      )
    ).toBe('env-1')
  })

  it('returns null for an ssh-connection worktree (Model A stays local)', () => {
    expect(
      selectNativeChatRuntimeEnvironmentId(
        state({ worktreesByRepo: worktreeRecord('ssh:conn-1') }),
        'wt-1'
      )
    ).toBeNull()
  })

  it('reports a missing bridge tab as a membership miss, separately from the nullable owner', () => {
    const scope = { kind: 'bridge', worktreeId: 'wt-1', tabId: 'tab-1' } as const
    const runtimeOwned = state({ worktreesByRepo: worktreeRecord('runtime:env-1') })
    expect(selectNativeChatBridgeMembership(runtimeOwned, scope)).toBe(true)
    const moved = { ...runtimeOwned, tabsByWorktree: { 'wt-2': [terminalTab()] } }
    expect(selectNativeChatBridgeMembership(moved, scope)).toBe(false)
    // The owner stays the supplied workspace's; transport is suspended by membership, not a null.
    expect(selectNativeChatRuntimeEnvironmentId(moved, 'wt-1')).toBe('env-1')
  })

  it('returns the owner id even when the worktree record has no resolvable path', () => {
    // Guards KTD-1: no `path` on the worktree record and no getKnownWorktreeById —
    // the selector must still resolve the runtime owner from the host mapping alone.
    expect(
      selectNativeChatRuntimeEnvironmentId(
        state({ worktreesByRepo: worktreeRecord('runtime:env-1') }),
        'wt-1'
      )
    ).toBe('env-1')
  })
})
