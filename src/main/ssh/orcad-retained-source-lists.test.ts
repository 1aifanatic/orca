import { describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import { isAdmissibleDirectSshAuthority } from '../../shared/ssh-retained-payload-admission'
import type { Store } from '../persistence'

vi.mock('./ssh-provider-authority', () => ({ isCurrentSshProviderAuthority: () => true }))
const provider = {}
vi.mock('../providers/ssh-git-dispatch', () => ({ getSshGitProvider: () => provider }))

const { visibleProjectGroups } = await import('./orcad-retained-source')
const { listReposForExecutionHost } = await import('../ipc/repos/host-repo-catalog-snapshot')

const FENCED: SshTarget = {
  id: 'ssh-box',
  label: 'Box',
  host: 'box.example.com',
  port: 22,
  username: 'me',
  orcadFence: { environmentId: 'env-1' }
}

function group(id: string, connectionId: string | null): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: '/srv',
    parentGroupId: null,
    connectionId,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

const sourceRepo: Repo = {
  id: 'repo-1',
  path: '/srv/app',
  displayName: 'App',
  badgeColor: '#737373',
  addedAt: 1,
  kind: 'git',
  connectionId: FENCED.id
}

function catalog(targets: SshTarget[]): Store {
  const groups = [group('source-group', FENCED.id), group('local-group', null)]
  const folders: FolderWorkspace[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lists read only these four getters.
  return {
    getSshTargets: () => targets,
    getRepos: () => [sourceRepo],
    getProjectGroups: () => groups,
    getFolderWorkspaces: () => folders
  } as unknown as Store
}

describe('lists while a converted host keeps its source rows', () => {
  it('hides the host own project groups, but not a local group', () => {
    expect(visibleProjectGroups(catalog([FENCED])).map((entry) => entry.id)).toEqual([
      'local-group'
    ])
  })

  it('shows them again once an older build changed the host', () => {
    const changed = { ...FENCED, orcadFence: { environmentId: 'env-1', sourceChangedAt: 'x' } }
    expect(visibleProjectGroups(catalog([changed])).map((entry) => entry.id)).toEqual([
      'source-group',
      'local-group'
    ])
  })

  it('leaves the source repos out of the host catalog the SSH bridge hydrates from', async () => {
    const authority: unknown = { targetId: FENCED.id, providerEpoch: 'e1', connectionGeneration: 1 }
    if (!isAdmissibleDirectSshAuthority(authority)) {
      throw new Error('fixture authority rejected')
    }
    const snapshot = await listReposForExecutionHost(catalog([FENCED]), {
      executionHostId: `ssh:${FENCED.id}`,
      expectedAuthority: authority
    })
    expect(snapshot).toMatchObject({ authoritative: true, repos: [] })
  })
})
