import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  REPO_PATH,
  readFileMock,
  writeFileMock,
  statMock,
  realpathMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
vi.mock('fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock(
  '../wsl-unc-delete',
  async () => (await import('./filesystem-test-harness')).wslUncDeleteMock
)
vi.mock(
  '../crash-reporting/crash-breadcrumb-store',
  async () => (await import('./filesystem-test-harness')).crashBreadcrumbMock
)
vi.mock(
  '../local-downloaded-folder-promotion',
  async () => (await import('./filesystem-test-harness')).folderPromotionMock
)
vi.mock(
  '../git/status',
  async () => (await import('./filesystem-test-harness')).gitStatusModuleMock
)
vi.mock(
  '../git/check-ignored-paths',
  async () => (await import('./filesystem-test-harness')).gitIgnoredPathsMock
)
vi.mock('../git/worktree', async () => (await import('./filesystem-test-harness')).gitWorktreeMock)
vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./filesystem-test-harness')).sshFilesystemDispatchMock
)
vi.mock(
  '../providers/ssh-git-dispatch',
  async () => (await import('./filesystem-test-harness')).sshGitDispatchMock
)
vi.mock(
  '../text-generation/commit-message-text-generation',
  async () => (await import('./filesystem-test-harness')).textGenerationModuleMock
)
vi.mock(
  '../text-generation/pull-request-context',
  async () => (await import('./filesystem-test-harness')).pullRequestContextMock
)
vi.mock(
  '../source-control/pull-request-template',
  async () => (await import('./filesystem-test-harness')).pullRequestTemplateMock
)
vi.mock(
  '../source-control/pull-request-linked-issue',
  async () => (await import('./filesystem-test-harness')).pullRequestLinkedIssueMock
)

import { registerFilesystemHandlers } from './filesystem'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'

const OUTSIDE_FILE = path.resolve('/Users/me/notes.txt')
const PATH_ACCESS_DENIED = 'Access denied: path resolves outside allowed directories'

describe('user-named paths outside every project', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    invalidateAuthorizedRootsCache()
    readFileMock.mockResolvedValue(Buffer.from('hello'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared harness store implements only the repo and settings reads these handlers make.
    registerFilesystemHandlers(store as never)
  })

  it('reads a file outside every project without a grant', async () => {
    await expect(handlers.get('fs:readFile')!(null, { filePath: OUTSIDE_FILE })).resolves.toEqual({
      content: 'hello',
      isBinary: false
    })
    expect(readFileMock).toHaveBeenCalledWith(OUTSIDE_FILE)
  })

  it('stats a file outside every project and reports a missing one as absent', async () => {
    await expect(handlers.get('fs:stat')!(null, { filePath: OUTSIDE_FILE })).resolves.toEqual({
      size: 10,
      isDirectory: false,
      mtime: 123
    })

    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    await expect(handlers.get('fs:pathExists')!(null, { filePath: OUTSIDE_FILE })).resolves.toBe(
      false
    )
  })

  it('rejects a relative path instead of resolving it against the app directory', async () => {
    await expect(handlers.get('fs:readFile')!(null, { filePath: 'notes.txt' })).rejects.toThrow(
      PATH_ACCESS_DENIED
    )
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('still rejects a project symlink reached through an alias of the project folder', async () => {
    const aliasRepoPath = path.resolve('/alias/repo')
    const aliasLinkPath = path.join(aliasRepoPath, 'link.txt')
    realpathMock.mockImplementation(async (targetPath: string) => {
      if (targetPath === aliasRepoPath) {
        return REPO_PATH
      }
      if (targetPath === aliasLinkPath) {
        return path.resolve('/private/secret.txt')
      }
      return targetPath
    })

    await expect(handlers.get('fs:readFile')!(null, { filePath: aliasLinkPath })).rejects.toThrow(
      PATH_ACCESS_DENIED
    )
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('saves an open editor file outside every project but keeps other writes inside projects', async () => {
    await expect(
      handlers.get('fs:writeFile')!(null, { filePath: OUTSIDE_FILE, content: 'other write' })
    ).rejects.toThrow(PATH_ACCESS_DENIED)
    expect(writeFileMock).not.toHaveBeenCalled()

    await handlers.get('fs:writeFile')!(null, {
      filePath: OUTSIDE_FILE,
      content: 'editor save',
      savesOpenEditorFile: true
    })
    expect(writeFileMock).toHaveBeenCalledWith(OUTSIDE_FILE, 'editor save', 'utf-8')
  })

  it('does not let an editor save write through a project symlink that escapes it', async () => {
    const linkPath = path.join(REPO_PATH, 'link.txt')
    realpathMock.mockImplementation(async (targetPath: string) =>
      targetPath === linkPath ? path.resolve('/private/secret.txt') : targetPath
    )

    await expect(
      handlers.get('fs:writeFile')!(null, {
        filePath: linkPath,
        content: 'editor save',
        savesOpenEditorFile: true
      })
    ).rejects.toThrow(PATH_ACCESS_DENIED)
    expect(writeFileMock).not.toHaveBeenCalled()
  })
})
