import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  getEffectiveHooks,
  listWorktrees
} from '../orca-runtime-test-mocks.spec'
import { store } from '../orca-runtime-test-fixtures.spec'

function createRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(store)
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  runtime.attachWindow(1)
  return runtime
}

describe('runtime worktree creation content origin', () => {
  it("stamps a branch create as the repository's own content", async () => {
    const setMeta = vi.spyOn(store, 'setWorktreeMeta')
    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/origin-branch')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/origin-branch')
    vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: {} })
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/origin-branch',
        head: 'def',
        branch: 'origin-branch',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await createRuntime().createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'origin-branch'
    })

    expect(setMeta).toHaveBeenCalledWith(
      expect.stringContaining('origin-branch'),
      expect.objectContaining({ orcaCreationContentOrigin: 'repo-ref' })
    )
    setMeta.mockRestore()
  })
})
