import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeProjectGroupController } from './runtime-project-group-controller'
import { FolderWorkspaceCreateRefusedError } from '../project-groups/folder-workspace-create-refusal'

const MISSING_PATH = join(tmpdir(), 'orca-folder-create-missing-9c1f')

function createController() {
  const createFolderWorkspace = vi.fn()
  const notifyReposChanged = vi.fn()
  const controller = new RuntimeProjectGroupController({
    getStore: () =>
      ({
        getProjectGroups: () => [{ id: 'group-1', parentPath: MISSING_PATH, connectionId: null }],
        getRepos: () => [],
        createFolderWorkspace
      }) as never,
    resolveRepo: async () => {
      throw new Error('unused')
    },
    notifyReposChanged,
    resolveFolderConnectionId: () => null,
    teardownFolderWorkspacePtys: async () => undefined,
    cleanupRemovedFolderWorkspaceState: () => undefined
  })
  return { controller, createFolderWorkspace, notifyReposChanged }
}

// A launch reads these as "nothing was created", so each must come before the store write and keep
// the code `folderWorkspace.create` has always answered with.
describe('RuntimeProjectGroupController.createFolderWorkspace refusals', () => {
  it.each([
    ['a group that is gone', 'group-2', 'folder_workspace_project_group_not_found'],
    ['a folder that is missing', 'group-1', `folder_workspace_path_missing:${MISSING_PATH}`]
  ])('refuses %s as a typed refusal without storing anything', async (_case, groupId, code) => {
    const deps = createController()

    const refused = deps.controller.createFolderWorkspace({ projectGroupId: groupId })

    await expect(refused).rejects.toBeInstanceOf(FolderWorkspaceCreateRefusedError)
    await expect(refused).rejects.toThrow(code)
    expect(deps.createFolderWorkspace).not.toHaveBeenCalled()
    expect(deps.notifyReposChanged).not.toHaveBeenCalled()
  })
})
