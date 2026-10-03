import { beforeEach, describe, expect, it, vi } from 'vitest'

const viewer = vi.hoisted(() => vi.fn())
vi.mock('../github/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAuthenticatedViewer: viewer
}))

import type { Repo } from '../../shared/repo-types'
import type { LocalProjectGhExecOptions } from '../project-runtime-git-options'
import { RuntimeGitHubReviewQueryCommands } from './runtime-github-review-query-commands'

function commands(repo: Partial<Repo>, options?: LocalProjectGhExecOptions) {
  return new RuntimeGitHubReviewQueryCommands({
    resolveRepo: async (): Promise<Repo> => ({
      id: 'repo-1',
      path: '/repos/app',
      displayName: 'app',
      badgeColor: 'blue',
      addedAt: 1,
      ...repo
    }),
    getLocalGitArgs: () => (options ? [options] : [])
  })
}

describe("the GitHub login a repo's writes run as", () => {
  beforeEach(() => {
    viewer.mockReset()
    viewer.mockResolvedValue({ login: 'signed-in', email: null })
  })

  it("is the repo's bound account", async () => {
    const login = await commands(
      {},
      {
        ghAccount: { host: 'github.com', user: 'bound' }
      }
    ).getRepoViewerLogin('id:repo-1')
    expect(login).toBe('bound')
    expect(viewer).not.toHaveBeenCalled()
  })

  it('is the signed-in gh user otherwise', async () => {
    await expect(commands({}).getRepoViewerLogin('id:repo-1')).resolves.toBe('signed-in')
  })

  it('is unknown where the signed-in user is not the one the writes run as', async () => {
    await expect(commands({ connectionId: 'ssh-1' }).getRepoViewerLogin('x')).resolves.toBeNull()
    await expect(commands({}, { wslDistro: 'Ubuntu' }).getRepoViewerLogin('x')).resolves.toBeNull()
    expect(viewer).not.toHaveBeenCalled()
  })
})
