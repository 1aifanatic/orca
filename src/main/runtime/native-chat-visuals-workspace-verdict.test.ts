import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { createNativeChatVisualsWorkspaceVerdict } from './native-chat-visuals-workspace-verdict'

const WORKTREE_ID = 'repo-1::/work/repo-1-feature'

function catalog(
  options: {
    repos?: string[]
    meta?: string[]
    folders?: string[]
  } = {}
) {
  return {
    getRepo: (id: string) =>
      (options.repos ?? ['repo-1']).includes(id) ? ({ id } as never) : undefined,
    getAllWorktreeMeta: () =>
      Object.fromEntries((options.meta ?? []).map((id) => [id, {} as never])),
    getFolderWorkspaces: () => (options.folders ?? []).map((id) => ({ id }) as never)
  }
}

const at = (
  workspaceId: string,
  overrides: Partial<AgentSessionExecutionLocation> = {}
): AgentSessionExecutionLocation => ({
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  wslDistro: null,
  workspaceId,
  workspaceKind: 'git-worktree',
  ...overrides
})

type Presence = 'present' | 'absent' | 'unknown'

function verdictWith(
  store: ReturnType<typeof catalog> | null,
  paths: Record<string, Presence> = {}
) {
  const pathPresence = vi.fn(async (path: string): Promise<Presence> => paths[path] ?? 'present')
  return {
    verdict: createNativeChatVisualsWorkspaceVerdict(() => store, pathPresence),
    pathPresence
  }
}

describe('whether a chat workspace is provably removed', () => {
  it('is removed when its project was removed from Orca', async () => {
    const { verdict, pathPresence } = verdictWith(catalog({ repos: [] }))
    await expect(verdict(at(WORKTREE_ID))).resolves.toBe('removed')
    expect(pathPresence).not.toHaveBeenCalled()
  })

  it('is present while Orca still tracks the worktree', async () => {
    const { verdict, pathPresence } = verdictWith(catalog({ meta: [WORKTREE_ID] }), {
      '/work/repo-1-feature': 'absent'
    })
    await expect(verdict(at(WORKTREE_ID))).resolves.toBe('present')
    expect(pathPresence).not.toHaveBeenCalled()
  })

  it('is removed when an untracked worktree folder is gone and its parent is not', async () => {
    const { verdict } = verdictWith(catalog(), { '/work/repo-1-feature': 'absent' })
    await expect(verdict(at(WORKTREE_ID))).resolves.toBe('removed')
  })

  it('keeps a worktree whose folder is there, unreadable, or on a missing volume', async () => {
    await expect(verdictWith(catalog()).verdict(at(WORKTREE_ID))).resolves.toBe('present')
    await expect(
      verdictWith(catalog(), { '/work/repo-1-feature': 'unknown' }).verdict(at(WORKTREE_ID))
    ).resolves.toBe('unverifiable')
    await expect(
      verdictWith(catalog(), { '/work/repo-1-feature': 'absent', '/work': 'absent' }).verdict(
        at(WORKTREE_ID)
      )
    ).resolves.toBe('unverifiable')
  })

  it('reads a folder workspace from the catalog', async () => {
    const folder = (id: string) => at(`folder:${id}`, { workspaceKind: 'folder' })
    const { verdict } = verdictWith(catalog({ folders: ['f-1'] }))
    await expect(verdict(folder('f-1'))).resolves.toBe('present')
    await expect(verdict(folder('f-2'))).resolves.toBe('removed')
  })

  it('never decides for another host, a WSL distro, the floating workspace, or without a catalog', async () => {
    const { verdict, pathPresence } = verdictWith(catalog({ repos: [] }))
    await expect(verdict(at(WORKTREE_ID, { executionHostId: 'ssh:box' as never }))).resolves.toBe(
      'unverifiable'
    )
    await expect(verdict(at(WORKTREE_ID, { wslDistro: 'Ubuntu' }))).resolves.toBe('unverifiable')
    await expect(
      verdict(at(FLOATING_TERMINAL_WORKTREE_ID, { workspaceKind: 'folder' }))
    ).resolves.toBe('unverifiable')
    await expect(verdictWith(null).verdict(at(WORKTREE_ID))).resolves.toBe('unverifiable')
    expect(pathPresence).not.toHaveBeenCalled()
  })
})
