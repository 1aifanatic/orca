import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import { collectOrcadSourceStateView } from './orcad-source-state-view'

const REPO: Repo = {
  id: 'repo-1',
  path: '/srv/app',
  displayName: 'app',
  badgeColor: '#737373',
  addedAt: 1,
  connectionId: 'ssh-prod'
}
const source = { sshTargetId: 'ssh-prod', sshTargetGeneration: 1, targetLabel: 'Prod' }
const catalog = { repositories: [REPO], projectGroups: [], folderWorkspaces: [] }

function profile(openFilesByWorktree: unknown): PersistedState {
  const state = getDefaultPersistedState('/home/test')
  state.repos = [REPO]
  const partition = { ...state.workspaceSession }
  // Planted untyped: a damaged profile can hold a shape the schema would reject.
  Reflect.set(partition, 'openFilesByWorktree', openFilesByWorktree)
  state.workspaceSessionsByHostId = { 'ssh:ssh-prod': partition }
  return state
}

describe('the retained source state a user wrote', () => {
  it('reads drafts from the source partition directly', () => {
    const view = collectOrcadSourceStateView(
      profile({
        'repo-1::/srv/app': [
          {
            filePath: '/srv/app/notes.md',
            relativePath: 'notes.md',
            worktreeId: 'repo-1::/srv/app',
            language: 'markdown',
            dirtyDraftContent: 'NEW EDIT'
          }
        ]
      }),
      source,
      catalog
    )
    expect(view?.drafts).toEqual([['repo-1::/srv/app', '/srv/app/notes.md', 'NEW EDIT']])
  })

  it('is unreadable, never empty, when a session holds a shape it cannot read', () => {
    expect(
      collectOrcadSourceStateView(profile({ 'repo-1::/srv/app': 'corrupt' }), source, catalog)
    ).toBeNull()
  })
})
