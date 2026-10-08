import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { hasHostAuthoritativeTerminalMembership } from '../terminal-topology/terminal-topology-membership'
import { normalizeLoadedLocalSession } from './normalize-loaded-state-collections'
import { parseWorkspaceSessionsByHostId } from './workspace-session-partitions'

const WORKTREE_ID = 'repo::/worktree'

/** A profile an older build saved: its close record was left for the next write to apply. */
function sessionWithUnappliedClose(incarnationId: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'closed-tab',
          ptyId: 'pty-1',
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      'closed-tab': {
        root: { type: 'leaf', leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
      }
    },
    terminalPtyIncarnationsByPaneKey: { 'closed-tab:leaf-1': 'incarnation-a' },
    terminalSurfaceTombstonesByPaneKey: {
      'closed-tab:leaf-1': {
        worktreeId: WORKTREE_ID,
        parentTabId: 'closed-tab',
        leafId: 'leaf-1',
        ptyId: 'pty-1',
        incarnationId,
        retiredAt: 42
      }
    }
  }
}

describe('loading a session an older build left close records in', () => {
  it('applies them, so the closed tab stays closed, then drops them', () => {
    const defaults = getDefaultPersistedState('/home/user')
    const loaded = normalizeLoadedLocalSession(
      { ...defaults, workspaceSession: sessionWithUnappliedClose('incarnation-a') },
      defaults,
      () => {}
    )

    expect(loaded.tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(loaded.terminalLayoutsByTabId['closed-tab']).toBeUndefined()
    expect(loaded.terminalSurfaceTombstonesByPaneKey).toEqual({})
  })

  it('drops one it cannot apply, so a runtime partition does not read as host-authoritative', () => {
    const { partitions } = parseWorkspaceSessionsByHostId(
      { 'runtime:env-1': sessionWithUnappliedClose('incarnation-b') },
      getDefaultWorkspaceSession()
    )
    const loaded = partitions['runtime:env-1']

    expect(loaded?.tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    expect(loaded?.terminalSurfaceTombstonesByPaneKey).toEqual({})
    expect(hasHostAuthoritativeTerminalMembership(loaded, WORKTREE_ID)).toBe(false)
  })
})
