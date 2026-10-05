import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  type OrcadMigrationManifest
} from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import type { SshTarget } from '../../../shared/ssh-types'
import type { Tab } from '../../../shared/tab-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { retargetOrcadSourceClientFocus } from './orcad-source-client-focus-retarget'
import { collectOrcadMigrationUntransferredDependencyCensus } from './orcad-source-dependency-census'
import { collectOrcadMigrationSourceDormantState } from './orcad-source-dormant-state'
import {
  assertOrcadMigrationSourceWorkspaceSessionRetired,
  retireOrcadMigrationSourceWorkspaceSession
} from './orcad-source-workspace-session-retirement'

const TARGET: SshTarget = { id: 'ssh-prod', label: 'Prod', host: 'prod', port: 22, username: 'u' }
const SSH_HOST = `ssh:${TARGET.id}` as const
const REPO: Repo = {
  id: 'repo-1',
  path: '/srv/repo',
  displayName: 'Repository',
  badgeColor: '#737373',
  addedAt: 1,
  connectionId: TARGET.id,
  executionHostId: SSH_HOST
}
const WORKTREE = `${REPO.id}::/srv/repo`

function manifest(destinationEnvironmentId?: string): OrcadMigrationManifest {
  return {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: 'migration-1',
    createdAt: '2026-10-03T12:00:00.000Z',
    source: { sshTargetId: TARGET.id, sshTargetGeneration: null, targetLabel: TARGET.label },
    payload: { repositories: [REPO], projectGroups: [], folderWorkspaces: [] },
    ...(destinationEnvironmentId ? { destinationEnvironmentId } : {}),
    manifestSha256: 'a'.repeat(64)
  }
}

function editorTab(executionHostId?: ExecutionHostId): Tab {
  return {
    id: 'tab-1',
    entityId: '/srv/repo/README.md',
    groupId: 'group-1',
    worktreeId: WORKTREE,
    ...(executionHostId ? { executionHostId } : {}),
    contentType: 'editor',
    label: 'README.md',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function sourceState(): PersistedState {
  const state = getDefaultPersistedState('/home/test')
  state.sshTargets = [TARGET]
  state.repos = [REPO]
  return state
}

function focusLocalOnSourceWorktree(state: PersistedState): void {
  state.workspaceSession = {
    ...state.workspaceSession,
    activeRepoId: REPO.id,
    activeWorktreeId: WORKTREE,
    activeWorkspaceKey: worktreeWorkspaceKey(WORKTREE),
    activeWorkspaceExecutionHostId: SSH_HOST,
    activeTabId: 'tab-1'
  }
}

const sessionCount = (state: PersistedState): number =>
  collectOrcadMigrationUntransferredDependencyCensus(state, manifest('env-1')).counts[
    'workspace-session'
  ]

describe('orcad migration census and client focus', () => {
  it('never blocks a move on client focus aimed at a migrating worktree', () => {
    const state = sourceState()
    focusLocalOnSourceWorktree(state)

    expect(sessionCount(state)).toBe(0)
  })

  it('passes a v1.4.218 profile quit while focused on the source worktree', () => {
    // v1.4.218 copied the global focus fields into 'local' and into every host partition it wrote.
    const state = sourceState()
    focusLocalOnSourceWorktree(state)
    const focusCopy = {
      ...state.workspaceSession,
      unifiedTabs: {},
      tabsByWorktree: {}
    }
    state.workspaceSessionsByHostId = {
      [SSH_HOST]: { ...focusCopy, unifiedTabs: { [WORKTREE]: [editorTab('local')] } },
      'ssh:other-a': { ...focusCopy },
      'ssh:other-b': { ...focusCopy }
    }
    expect(sessionCount(state)).toBe(0)
  })

  it('carries no client focus into the destination session', () => {
    const state = sourceState()
    focusLocalOnSourceWorktree(state)
    state.workspaceSession.unifiedTabs = { [WORKTREE]: [editorTab(SSH_HOST)] }

    const session = collectOrcadMigrationSourceDormantState(state, manifest().source, {
      repositories: [REPO],
      projectGroups: [],
      folderWorkspaces: []
    }).payload.workspaceSession

    expect(session?.unifiedTabs?.[WORKTREE]).toHaveLength(1)
    expect(session?.activeWorktreeId ?? null).toBeNull()
    expect(session?.activeWorkspaceKey ?? null).toBeNull()
  })

  it('remaps client focus to the same worktree in the managed environment', () => {
    const state = sourceState()
    focusLocalOnSourceWorktree(state)

    const partitionKeys = Object.keys(state.workspaceSessionsByHostId ?? {})
    retargetOrcadSourceClientFocus(state, manifest('env-1'))

    expect(state.workspaceSession).toMatchObject({
      activeRepoId: REPO.id,
      activeWorktreeId: WORKTREE,
      activeWorkspaceKey: worktreeWorkspaceKey(WORKTREE),
      activeWorkspaceExecutionHostId: 'runtime:env-1',
      activeTabId: 'tab-1'
    })
    // Startup drops runtime:<id> sessions whose server is unregistered, so retirement must only
    // re-aim focus and never create the destination's session itself.
    expect(Object.keys(state.workspaceSessionsByHostId ?? {})).toEqual(partitionKeys)
  })

  it('clears client focus the managed environment cannot resolve', () => {
    const state = sourceState()
    focusLocalOnSourceWorktree(state)
    const unmoved = sourceState()
    focusLocalOnSourceWorktree(unmoved)
    unmoved.workspaceSession.activeWorktreeId = 'other-repo::/srv/other'
    unmoved.workspaceSession.activeWorkspaceKey = worktreeWorkspaceKey('other-repo::/srv/other')

    retargetOrcadSourceClientFocus(state, manifest())
    retargetOrcadSourceClientFocus(unmoved, manifest('env-1'))

    for (const session of [state.workspaceSession, unmoved.workspaceSession]) {
      expect(session).toMatchObject({
        activeRepoId: null,
        activeWorktreeId: null,
        activeWorkspaceKey: null,
        activeWorkspaceExecutionHostId: null,
        activeTabId: null
      })
    }
  })

  it('keeps remapped focus through session retirement, which then verifies clean', () => {
    const state = sourceState()
    focusLocalOnSourceWorktree(state)
    state.workspaceSession.unifiedTabs = { [WORKTREE]: [editorTab(SSH_HOST)] }
    const moved = manifest('env-1')
    moved.payload.dormantState = collectOrcadMigrationSourceDormantState(
      state,
      moved.source,
      moved.payload
    ).payload

    retargetOrcadSourceClientFocus(state, moved)
    retireOrcadMigrationSourceWorkspaceSession(state, moved)

    expect(state.workspaceSession.unifiedTabs?.[WORKTREE]).toBeUndefined()
    expect(state.workspaceSession).toMatchObject({
      activeWorktreeId: WORKTREE,
      activeWorkspaceExecutionHostId: 'runtime:env-1'
    })
    expect(() => assertOrcadMigrationSourceWorkspaceSessionRetired(state, moved)).not.toThrow()
  })

  it("counts a 'local'-stamped tab in a migrating SSH worktree as the SSH host's", () => {
    const local = sourceState()
    local.workspaceSession.unifiedTabs = { [WORKTREE]: [editorTab('local')] }
    const partitioned = sourceState()
    partitioned.workspaceSessionsByHostId = {
      [SSH_HOST]: {
        ...partitioned.workspaceSession,
        unifiedTabs: { [WORKTREE]: [editorTab('local')] }
      }
    }

    expect(sessionCount(local)).toBe(0)
    expect(sessionCount(partitioned)).toBe(0)
  })

  it('still blocks a tab another host owns inside a migrating worktree', () => {
    const state = sourceState()
    state.workspaceSession.unifiedTabs = { [WORKTREE]: [editorTab('ssh:other')] }

    expect(sessionCount(state)).toBe(1)
  })
})
