import { describe, expect, it } from 'vitest'
import { ORCAD_MIGRATION_MANIFEST_VERSION } from '../../shared/orcad-migration-manifest'
import {
  ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
  type OrcadMigrationSourceCutover
} from '../../shared/orcad-migration-source-cutover'
import type { Repo } from '../../shared/repo-types'
import type { OrcadSourceStateView } from '../persistence/migrating-orcad-catalog/orcad-source-state-view'
import { compareRetainedOrcadSource, currentOrcadSourceFingerprint } from './orcad-retained-source'
import { currentOrcadSourceStateFingerprint } from './orcad-retained-source-state'

const TARGET = { id: 'ssh-prod', generation: 1, label: 'Prod' }
const REPO: Repo = {
  id: 'repo-1',
  path: '/srv/app',
  displayName: 'app',
  badgeColor: '#737373',
  addedAt: 1,
  connectionId: TARGET.id
}

function sourceStore(view: OrcadSourceStateView | null) {
  return {
    getRepos: () => [REPO],
    getFolderWorkspaces: () => [],
    getProjectGroups: () => [],
    inspectOrcadMigrationSourceState: () => view
  }
}

function head(sourceStateFingerprint?: string): OrcadMigrationSourceCutover {
  return {
    version: ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
    migrationId: 'migration-1',
    phase: 'destination-committed',
    startedAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
    destinationEnvironmentId: 'env-1',
    destinationName: 'Managed',
    sshTargetId: TARGET.id,
    sshTargetGeneration: 1,
    manifestSha256: 'a'.repeat(64),
    provenPtyIds: [],
    sourceRetainedAt: '2026-10-05T00:00:00.000Z',
    sourceBaselineFingerprint: currentOrcadSourceFingerprint(sourceStore(null), TARGET),
    ...(sourceStateFingerprint ? { sourceStateFingerprint } : {}),
    manifest: {
      version: ORCAD_MIGRATION_MANIFEST_VERSION,
      migrationId: 'migration-1',
      createdAt: '2026-10-05T00:00:00.000Z',
      source: { sshTargetId: TARGET.id, sshTargetGeneration: 1, targetLabel: 'Prod' },
      payload: { repositories: [REPO], projectGroups: [], folderWorkspaces: [] },
      manifestSha256: 'a'.repeat(64)
    }
  }
}

const empty: OrcadSourceStateView = { drafts: [], automations: [], worktrees: [] }

describe('the retained source verdict', () => {
  it('is unverified, never unchanged, when a source session cannot be read', () => {
    const baseline = currentOrcadSourceStateFingerprint(sourceStore(empty), TARGET)!
    expect(compareRetainedOrcadSource(sourceStore(null), TARGET, head(baseline))).toBe('unverified')
  })

  it('is unchanged only against a recorded pre-commit baseline', () => {
    const baseline = currentOrcadSourceStateFingerprint(sourceStore(empty), TARGET)!
    expect(compareRetainedOrcadSource(sourceStore(empty), TARGET, head(baseline))).toBe('unchanged')
    expect(compareRetainedOrcadSource(sourceStore(empty), TARGET, head())).toBe('unverified')
  })
})
