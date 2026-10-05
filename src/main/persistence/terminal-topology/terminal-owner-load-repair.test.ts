import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { repairDuplicateTerminalOwners } from './terminal-owner-load-repair'

const WT = 'repo-1::/tmp/dupfx'
const PRIMARY_LEAF = '11111111-1111-4111-8111-111111111111'
const SETUP_LEAF = '22222222-2222-4222-8222-222222222222'
const MINTED_LEAF = '33333333-3333-4333-8333-333333333333'
const MOVED_LEAF = '44444444-4444-4444-8444-444444444444'
const SSH_HOST = 'ssh:box'

function tab(id: string, createdAt: number, ptyId: string | null = null): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: WT,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt
  }
}

function unified(tabId: string, lastFocusedAt?: number): Tab {
  return {
    id: tabId,
    entityId: tabId,
    groupId: 'group-1',
    worktreeId: WT,
    contentType: 'terminal',
    label: tabId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...(lastFocusedAt !== undefined ? { lastFocusedAt } : {})
  }
}

function single(leafId: string, ptyId?: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ...(ptyId ? { ptyIdsByLeafId: { [leafId]: ptyId } } : {})
  }
}

function split(
  first: string,
  second: string,
  ptyIds: Record<string, string>
): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: first },
      second: { type: 'leaf', leafId: second }
    },
    activeLeafId: first,
    expandedLeafId: null,
    ptyIdsByLeafId: ptyIds
  }
}

function session(patch: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), ...patch }
}

function repair(
  workspaceSession: WorkspaceSessionState,
  hosts?: Record<string, WorkspaceSessionState>
) {
  return repairDuplicateTerminalOwners({
    workspaceSession,
    ...(hosts ? { workspaceSessionsByHostId: hosts } : {})
  })
}

describe('load repair of duplicate terminal owners', () => {
  it('leaves a session without duplicates untouched', () => {
    const input = session({
      tabsByWorktree: { [WT]: [tab('tab-a', 1, 'pty-1')] },
      terminalLayoutsByTabId: { 'tab-a': single(PRIMARY_LEAF, 'pty-1') }
    })
    const result = repair(input)
    expect(result.repairs).toEqual([])
    expect(result.workspaceSession).toBe(input)
  })

  it('(1) keeps the first leaf in tree order when two leaves of one tab hold one terminal', () => {
    const result = repair(
      session({
        tabsByWorktree: { [WT]: [tab('tab-a', 1, 'pty-1')] },
        terminalLayoutsByTabId: {
          'tab-a': split(PRIMARY_LEAF, SETUP_LEAF, {
            [PRIMARY_LEAF]: 'pty-1',
            [SETUP_LEAF]: 'pty-1'
          })
        }
      })
    )
    expect(result.workspaceSession.terminalLayoutsByTabId['tab-a']?.ptyIdsByLeafId).toEqual({
      [PRIMARY_LEAF]: 'pty-1'
    })
    expect(result.repairs).toEqual([
      {
        rule: 'pty_bound_to_other_leaf',
        hostId: 'local',
        keptPaneKey: `tab-a:${PRIMARY_LEAF}`,
        droppedPaneKey: `tab-a:${SETUP_LEAF}`,
        action: 'unbound'
      }
    ])
  })

  // STA-9259: a detached pane's leaf kept in its source tab and minted again in the new one.
  it('(2) keeps a leaf held by two tabs in the newer tab', () => {
    const result = repair(
      session({
        tabsByWorktree: {
          [WT]: [tab('tab-source', 1, 'pty-left'), tab('tab-moved', 5, 'pty-agent')]
        },
        terminalLayoutsByTabId: {
          'tab-source': split(PRIMARY_LEAF, MOVED_LEAF, {
            [PRIMARY_LEAF]: 'pty-left',
            [MOVED_LEAF]: 'pty-agent'
          }),
          'tab-moved': single(MOVED_LEAF, 'pty-agent')
        },
        terminalPtyIncarnationsByPaneKey: {
          [`tab-source:${MOVED_LEAF}`]: 'inc-agent',
          [`tab-moved:${MOVED_LEAF}`]: 'inc-agent'
        }
      })
    )
    const repaired = result.workspaceSession
    expect(repaired.terminalLayoutsByTabId['tab-source']).toMatchObject({
      root: { type: 'leaf', leafId: PRIMARY_LEAF },
      ptyIdsByLeafId: { [PRIMARY_LEAF]: 'pty-left' }
    })
    expect(repaired.terminalLayoutsByTabId['tab-moved']?.ptyIdsByLeafId).toEqual({
      [MOVED_LEAF]: 'pty-agent'
    })
    expect(repaired.terminalPtyIncarnationsByPaneKey).toEqual({
      [`tab-moved:${MOVED_LEAF}`]: 'inc-agent'
    })
    expect(result.repairs).toEqual([
      expect.objectContaining({
        rule: 'leaf_in_other_tab',
        keptPaneKey: `tab-moved:${MOVED_LEAF}`,
        droppedPaneKey: `tab-source:${MOVED_LEAF}`,
        action: 'removed_leaf'
      })
    ])
  })

  // STA-9417: the setup split in tab B and the sweep's minted "Terminal 2" both hold the setup PTY.
  it('(3) keeps the setup split and removes the minted tab with no history', () => {
    const result = repair(
      session({
        tabsByWorktree: {
          [WT]: [tab('tab-b', 1, 'pty-primary'), tab('tab-minted', 9, 'pty-setup')]
        },
        terminalLayoutsByTabId: {
          'tab-b': split(PRIMARY_LEAF, SETUP_LEAF, {
            [PRIMARY_LEAF]: 'pty-primary',
            [SETUP_LEAF]: 'pty-setup'
          }),
          'tab-minted': single(MINTED_LEAF, 'pty-setup')
        },
        unifiedTabs: { [WT]: [unified('tab-b'), unified('tab-minted')] },
        tabGroups: {
          [WT]: [
            {
              id: 'group-1',
              worktreeId: WT,
              activeTabId: 'tab-b',
              tabOrder: ['tab-b', 'tab-minted'],
              recentTabIds: []
            }
          ]
        }
      })
    )
    const repaired = result.workspaceSession
    expect(repaired.tabsByWorktree[WT]?.map((t) => t.id)).toEqual(['tab-b'])
    expect(repaired.terminalLayoutsByTabId['tab-minted']).toBeUndefined()
    expect(repaired.unifiedTabs?.[WT]?.map((t) => t.id)).toEqual(['tab-b'])
    expect(repaired.tabGroups?.[WT]?.[0]?.tabOrder).toEqual(['tab-b'])
    expect(repaired.terminalLayoutsByTabId['tab-b']?.ptyIdsByLeafId).toEqual({
      [PRIMARY_LEAF]: 'pty-primary',
      [SETUP_LEAF]: 'pty-setup'
    })
    expect(result.repairs).toEqual([
      {
        rule: 'pty_bound_to_other_leaf',
        hostId: 'local',
        keptPaneKey: `tab-b:${SETUP_LEAF}`,
        droppedPaneKey: `tab-minted:${MINTED_LEAF}`,
        action: 'removed_tab'
      }
    ])
  })

  it('(3) keeps a focused single-leaf tab, unbinding the other without removing a focused tab', () => {
    const result = repair(
      session({
        tabsByWorktree: { [WT]: [tab('tab-old', 1, 'pty-1'), tab('tab-focused', 9, 'pty-1')] },
        terminalLayoutsByTabId: {
          'tab-old': single(PRIMARY_LEAF, 'pty-1'),
          'tab-focused': single(MINTED_LEAF, 'pty-1')
        },
        unifiedTabs: { [WT]: [unified('tab-old', 50), unified('tab-focused', 60)] }
      })
    )
    // Both have history, so the older tab wins and the other survives unbound.
    expect(result.workspaceSession.tabsByWorktree[WT]?.map((t) => t.id)).toEqual([
      'tab-old',
      'tab-focused'
    ])
    expect(result.workspaceSession.terminalLayoutsByTabId['tab-focused']?.ptyIdsByLeafId).toEqual(
      {}
    )
    expect(result.repairs[0]).toMatchObject({
      keptPaneKey: `tab-old:${PRIMARY_LEAF}`,
      droppedPaneKey: `tab-focused:${MINTED_LEAF}`,
      action: 'unbound'
    })
  })

  // Review S5: only a tab newer than the kept one is removed; an older loser is only unbound.
  it('(3) prefers the tab with history, unbinding an older tab without removing it', () => {
    const result = repair(
      session({
        tabsByWorktree: { [WT]: [tab('tab-old', 1, 'pty-1'), tab('tab-focused', 9, 'pty-1')] },
        terminalLayoutsByTabId: {
          'tab-old': single(PRIMARY_LEAF, 'pty-1'),
          'tab-focused': single(MINTED_LEAF, 'pty-1')
        },
        unifiedTabs: { [WT]: [unified('tab-old'), unified('tab-focused', 60)] }
      })
    )
    expect(result.workspaceSession.tabsByWorktree[WT]?.map((t) => t.id)).toEqual([
      'tab-old',
      'tab-focused'
    ])
    expect(result.workspaceSession.terminalLayoutsByTabId['tab-old']?.ptyIdsByLeafId).toEqual({})
    expect(result.repairs[0]).toMatchObject({
      keptPaneKey: `tab-focused:${MINTED_LEAF}`,
      droppedPaneKey: `tab-old:${PRIMARY_LEAF}`,
      action: 'unbound'
    })
  })

  // Review S5: relay ids repeat across relay restarts, so a pty-N id alone proves nothing.
  it('(3) leaves legacy relay ids without incarnations alone', () => {
    const ssh = session({
      tabsByWorktree: {
        [WT]: [tab('tab-a', 1, 'ssh:box@@pty-1'), tab('tab-b', 2, 'ssh:box@@pty-1')]
      },
      terminalLayoutsByTabId: {
        'tab-a': single(PRIMARY_LEAF, 'ssh:box@@pty-1'),
        'tab-b': single(SETUP_LEAF, 'ssh:box@@pty-1')
      }
    })
    const result = repair(session({}), { [SSH_HOST]: ssh })
    expect(result.repairs).toEqual([])
    expect(result.workspaceSessionsByHostId?.[SSH_HOST]).toBe(ssh)
  })

  it('(3) repairs an ssh partition and leaves an untouched local partition as it was', () => {
    const ptyId = 'ssh:box@@pty2:e:1'
    const local = session({})
    const result = repair(local, {
      [SSH_HOST]: session({
        tabsByWorktree: { [WT]: [tab('tab-b', 1, ptyId), tab('tab-minted', 9, ptyId)] },
        terminalLayoutsByTabId: {
          'tab-b': split(PRIMARY_LEAF, SETUP_LEAF, { [SETUP_LEAF]: ptyId }),
          'tab-minted': single(MINTED_LEAF, ptyId)
        }
      })
    })
    expect(result.workspaceSession).toBe(local)
    expect(
      result.workspaceSessionsByHostId?.[SSH_HOST]?.tabsByWorktree[WT]?.map((t) => t.id)
    ).toEqual(['tab-b'])
    expect(result.repairs).toEqual([
      expect.objectContaining({ hostId: SSH_HOST, action: 'removed_tab' })
    ])
  })

  // Review S4: when only the older copy is bound, the kept copy inherits the binding.
  it('(2) carries the only binding into the newer copy it keeps', () => {
    const result = repair(
      session({
        tabsByWorktree: { [WT]: [tab('tab-source', 1, 'pty-left'), tab('tab-moved', 5, null)] },
        terminalLayoutsByTabId: {
          'tab-source': split(PRIMARY_LEAF, MOVED_LEAF, {
            [PRIMARY_LEAF]: 'pty-left',
            [MOVED_LEAF]: 'pty-agent'
          }),
          'tab-moved': single(MOVED_LEAF)
        },
        terminalPtyIncarnationsByPaneKey: { [`tab-source:${MOVED_LEAF}`]: 'inc-agent' }
      })
    )
    const repaired = result.workspaceSession
    expect(repaired.terminalLayoutsByTabId['tab-moved']?.ptyIdsByLeafId).toEqual({
      [MOVED_LEAF]: 'pty-agent'
    })
    expect(repaired.terminalPtyIncarnationsByPaneKey).toEqual({
      [`tab-moved:${MOVED_LEAF}`]: 'inc-agent'
    })
    expect(repaired.tabsByWorktree[WT]?.find((t) => t.id === 'tab-moved')?.ptyId).toBe('pty-agent')
    expect(repaired.terminalLayoutsByTabId['tab-source']?.ptyIdsByLeafId).toEqual({
      [PRIMARY_LEAF]: 'pty-left'
    })
  })

  it('treats distinct recorded incarnations of one PTY id as different terminals', () => {
    const result = repair(
      session({
        tabsByWorktree: { [WT]: [tab('tab-a', 1, 'pty-1'), tab('tab-b', 2, 'pty-1')] },
        terminalLayoutsByTabId: {
          'tab-a': single(PRIMARY_LEAF, 'pty-1'),
          'tab-b': single(MINTED_LEAF, 'pty-1')
        },
        terminalPtyIncarnationsByPaneKey: {
          [`tab-a:${PRIMARY_LEAF}`]: 'inc-1',
          [`tab-b:${MINTED_LEAF}`]: 'inc-2'
        }
      })
    )
    expect(result.repairs).toEqual([])
  })

  // Review S3: the relay reattach recreates this shape every session and the invariant accepts it.
  it('leaves an SSH pane that local and its ssh partition both hold alone', () => {
    const ptyId = 'ssh:box@@pty2:e:1'
    const copy = () =>
      session({
        tabsByWorktree: { [WT]: [tab('tab-a', 1, ptyId)] },
        terminalLayoutsByTabId: { 'tab-a': single(PRIMARY_LEAF, ptyId) },
        terminalPtyIncarnationsByPaneKey: { [`tab-a:${PRIMARY_LEAF}`]: 'inc' }
      })
    const local = copy()
    const result = repair(local, { [SSH_HOST]: copy() })
    expect(result.repairs).toEqual([])
    expect(result.workspaceSession).toBe(local)
  })

  it('is deterministic and idempotent', () => {
    const input = () =>
      session({
        tabsByWorktree: {
          [WT]: [tab('tab-b', 1, 'pty-primary'), tab('tab-minted', 9, 'pty-setup')]
        },
        terminalLayoutsByTabId: {
          'tab-b': split(PRIMARY_LEAF, SETUP_LEAF, {
            [PRIMARY_LEAF]: 'pty-primary',
            [SETUP_LEAF]: 'pty-setup'
          }),
          'tab-minted': single(MINTED_LEAF, 'pty-setup')
        }
      })
    const first = repair(input())
    expect(repair(input())).toEqual(first)
    expect(repair(first.workspaceSession).repairs).toEqual([])
  })
})
