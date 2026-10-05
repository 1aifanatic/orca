/**
 * The retained-source verdict over real profile state: worktree metadata that export and
 * retirement own must also be in the fingerprint, or an older build's edit reads as unchanged and
 * retirement deletes it.
 */
import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import { ORCAD_MIGRATION_MANIFEST_VERSION } from '../../shared/orcad-migration-manifest'
import {
  ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
  type OrcadMigrationSourceCutover
} from '../../shared/orcad-migration-source-cutover'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { Repo } from '../../shared/repo-types'
import { composeWorktreeHostIdentity } from '../../shared/worktree/host-qualified-identity'
import { canonicalWorktreeIdentity } from '../../shared/worktree/identity'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { collectOrcadSourceStateView } from '../persistence/migrating-orcad-catalog/orcad-source-state-view'
import { compareRetainedOrcadSource, currentOrcadSourceFingerprint } from './orcad-retained-source'
import { currentOrcadSourceStateFingerprint } from './orcad-retained-source-state'

const TARGET = { id: 'host-a', generation: 3, label: 'A' }
const HOST = 'ssh:host-a' as const
const REPO_A: Repo = {
  id: 'repo-1',
  path: '/srv/repo',
  displayName: 'Repository',
  badgeColor: '#737373',
  addedAt: 1,
  connectionId: TARGET.id
}
// Host B registered the same repository id, so unqualified keys need meta.hostId to attribute.
const REPO_B: Repo = { ...REPO_A, connectionId: 'host-b' }
const WORKTREE = `${REPO_A.id}::/srv/repo`

function meta(comment: string, extra: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: 'worktree',
    comment,
    isUnread: false,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    ...extra
  }
}

function store(state: PersistedState) {
  return {
    getRepos: () => state.repos,
    getFolderWorkspaces: () => state.folderWorkspaces ?? [],
    getProjectGroups: () => state.projectGroups ?? [],
    inspectOrcadMigrationSourceState: (
      source: Parameters<typeof collectOrcadSourceStateView>[1],
      catalog: Parameters<typeof collectOrcadSourceStateView>[2]
    ) => collectOrcadSourceStateView(state, source, catalog)
  }
}

function head(state: PersistedState): OrcadMigrationSourceCutover {
  const baseline = currentOrcadSourceStateFingerprint(store(state), TARGET)
  expect(baseline).not.toBeNull()
  return {
    version: ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
    migrationId: 'migration-1',
    phase: 'destination-committed',
    startedAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
    destinationEnvironmentId: 'env-1',
    destinationName: 'Managed',
    sshTargetId: TARGET.id,
    sshTargetGeneration: TARGET.generation,
    manifestSha256: 'a'.repeat(64),
    provenPtyIds: [],
    sourceRetainedAt: '2026-10-05T00:00:00.000Z',
    sourceBaselineFingerprint: currentOrcadSourceFingerprint(store(state), TARGET),
    sourceStateFingerprint: baseline ?? undefined,
    manifest: {
      version: ORCAD_MIGRATION_MANIFEST_VERSION,
      migrationId: 'migration-1',
      createdAt: '2026-10-05T00:00:00.000Z',
      source: { sshTargetId: TARGET.id, sshTargetGeneration: TARGET.generation, targetLabel: 'A' },
      payload: { repositories: [REPO_A], projectGroups: [], folderWorkspaces: [] },
      manifestSha256: 'a'.repeat(64)
    }
  }
}

function sharedRepoState(): PersistedState {
  const state = getDefaultPersistedState('/home/test')
  state.repos = [REPO_A, REPO_B]
  state.worktreeMeta[WORKTREE] = meta('Before note', { hostId: HOST })
  return state
}

function identityBackedState(comment = 'Before note'): PersistedState {
  const state = getDefaultPersistedState('/home/test')
  state.repos = [REPO_A]
  const identity = canonicalWorktreeIdentity({
    worktreeId: WORKTREE,
    executionHostId: HOST,
    instanceId: 'instance-1'
  })
  state.worktreeIdentityAliases = { [composeWorktreeHostIdentity(HOST, WORKTREE)]: [identity] }
  state.worktreeMetaByIdentity = {
    [identity]: meta(comment, { hostId: HOST, instanceId: 'instance-1' })
  }
  return state
}

describe('retained-source worktree metadata', () => {
  it('sees an edit to an unqualified row its hostId attributes when hosts share a repo id', () => {
    const state = sharedRepoState()
    const journal = head(state)
    expect(compareRetainedOrcadSource(store(state), TARGET, journal)).toBe('unchanged')

    state.worktreeMeta[WORKTREE] = meta('Written after downgrade', { hostId: HOST })
    expect(compareRetainedOrcadSource(store(state), TARGET, journal)).toBe('changed')
  })

  it('sees an edit to identity-backed metadata with no legacy row', () => {
    const state = identityBackedState()
    const journal = head(state)
    expect(compareRetainedOrcadSource(store(state), TARGET, journal)).toBe('unchanged')

    const edited = identityBackedState('Written after downgrade')
    expect(compareRetainedOrcadSource(store(edited), TARGET, journal)).toBe('changed')
  })

  it('stays unverified while a legacy row and its identity disagree', () => {
    const state = identityBackedState()
    const journal = head(state)
    state.worktreeMeta[WORKTREE] = meta('A different legacy note', { hostId: HOST })
    expect(compareRetainedOrcadSource(store(state), TARGET, journal)).toBe('unverified')
  })
})
