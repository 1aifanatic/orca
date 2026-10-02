import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import {
  getEditorTabExternalPathGrantTarget,
  refreshEditorTabExternalPathGrant
} from './editor-tab-external-path-grant'

const initialState = useAppStore.getInitialState()

function makeRepo(overrides: Partial<Repo> & { id: string; path: string }): Repo {
  return { displayName: 'repo', badgeColor: '#000', addedAt: 0, ...overrides }
}

function makeWorktree(overrides: Partial<Worktree> & { id: string; repoId: string }): Worktree {
  return {
    path: '/Users/me/project',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'project',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

const localWorktreeId = 'repo-local::/Users/me/project'
const sshWorktreeId = 'repo-ssh::/work/project'

function grantTarget(file: {
  filePath: string
  relativePath: string
  worktreeId: string
  runtimeEnvironmentId?: string | null
  externalSshTargetId?: string
}): string | null {
  return getEditorTabExternalPathGrantTarget(useAppStore.getState(), file)
}

describe('getEditorTabExternalPathGrantTarget', () => {
  beforeEach(() => {
    useAppStore.setState({
      repos: [
        makeRepo({ id: 'repo-local', path: '/Users/me/project' }),
        makeRepo({ id: 'repo-ssh', path: '/work/project', connectionId: 'ssh-1' })
      ],
      worktreesByRepo: {
        'repo-local': [makeWorktree({ id: localWorktreeId, repoId: 'repo-local' })]
      }
    })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
    vi.unstubAllGlobals()
  })

  it('grants a restored floating-workspace tab that stores a root-relative path', () => {
    expect(
      grantTarget({
        filePath: '/Users/me/notes.txt',
        relativePath: 'notes.txt',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID
      })
    ).toBe('/Users/me/notes.txt')
  })

  it('grants a client-local tab stored outside its own project', () => {
    expect(
      grantTarget({
        filePath: '/Users/me/notes/audit.md',
        relativePath: '/Users/me/notes/audit.md',
        worktreeId: localWorktreeId
      })
    ).toBe('/Users/me/notes/audit.md')
  })

  it('does not grant a project tab, which its authorized root already covers', () => {
    expect(
      grantTarget({
        filePath: '/Users/me/project/src/link.ts',
        relativePath: 'src/link.ts',
        worktreeId: localWorktreeId
      })
    ).toBeNull()
  })

  it('keeps SSH-owned external tabs off the local grant', () => {
    expect(
      grantTarget({
        filePath: '/work/reports/audit.md',
        relativePath: '/work/reports/audit.md',
        worktreeId: sshWorktreeId
      })
    ).toBeNull()
    expect(
      grantTarget({
        filePath: '/work/reports/audit.md',
        relativePath: '/work/reports/audit.md',
        worktreeId: localWorktreeId,
        externalSshTargetId: 'ssh-1'
      })
    ).toBeNull()
  })

  it('does not grant an external tab whose owner has not hydrated yet', () => {
    expect(
      grantTarget({
        filePath: '/work/reports/audit.md',
        relativePath: '/work/reports/audit.md',
        worktreeId: 'repo-missing::/work/other'
      })
    ).toBeNull()
  })

  it('does not grant an external tab in a folder workspace whose host is unknown', () => {
    // Why: a missing or ambiguous folder host may be SSH; only an explicitly local owner is granted.
    expect(
      grantTarget({
        filePath: '/home/remote-user/notes.md',
        relativePath: '/home/remote-user/notes.md',
        worktreeId: folderWorkspaceKey('fw-missing')
      })
    ).toBeNull()
  })

  it('does not grant a runtime-owned tab, which the runtime reads remotely', () => {
    expect(
      grantTarget({
        filePath: '/Users/me/notes.txt',
        relativePath: 'notes.txt',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: 'runtime-1'
      })
    ).toBeNull()
  })

  it('skips the grant call entirely when none is needed', async () => {
    const authorizeExternalPath = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { fs: { authorizeExternalPath } } })
    const state = useAppStore.getState()

    expect(
      refreshEditorTabExternalPathGrant(state, {
        filePath: '/Users/me/project/a.ts',
        relativePath: 'a.ts',
        worktreeId: localWorktreeId
      })
    ).toBeNull()
    await refreshEditorTabExternalPathGrant(state, {
      filePath: '/Users/me/notes.txt',
      relativePath: 'notes.txt',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })
    expect(authorizeExternalPath).toHaveBeenCalledTimes(1)
    // Main, not the renderer, decides whether a project root already covers the path.
    expect(authorizeExternalPath).toHaveBeenCalledWith({
      targetPath: '/Users/me/notes.txt',
      skipIfInsideAllowedRoots: true
    })
  })
})
