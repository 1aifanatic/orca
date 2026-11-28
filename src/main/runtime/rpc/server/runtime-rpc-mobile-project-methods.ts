/** Projects, groups and folder workspaces on the host the phone names; spread into the execution-host routes. */
export const MOBILE_PROJECT_RPC_METHODS = [
  // A folder row's Delete removes the Orca workspace on its host, as desktop's Remove Workspace does.
  'folderWorkspace.delete',
  'folderWorkspace.list',
  'projectGroup.list',
  'project.list',
  'projectHostSetup.list',
  'repo.baseRefDefault',
  'repo.gitAvailable',
  'repo.hooks',
  'repo.list',
  'repo.saveSparsePreset',
  'repo.searchRefs',
  'repo.sparsePresets',
  'repo.update',
  // Add project from the phone (mobile.project-admission.v1): the host's own add, clone and create rules.
  'repo.add',
  'repo.checkCloneTarget',
  'repo.clone',
  'repo.create',
  'repo.defaultCreateParent',
  // A group's folder workspace; also admits agent.launch's create-folder-workspace target
  // (agent-launch-target-authorization.ts). The host checks the group's setup trust itself.
  'folderWorkspace.create'
] as const
