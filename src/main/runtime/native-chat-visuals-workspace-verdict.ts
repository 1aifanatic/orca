// Whether the local workspace a chat ran in is provably gone, for the visuals folder sweep.
// Reads only this profile's workspace catalog and, for a worktree the catalog no longer tracks,
// the filesystem. Never lists a repo's worktrees: that git walk can touch protected folders.

import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { isFloatingWorkspaceId } from '../../shared/floating-workspace-worktree'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../shared/workspace-scope'
import type { Store } from '../persistence'
import type { NativeChatVisualsWorkspaceVerdict } from '../native-chat/native-chat-visuals-sweep'

type WorkspaceCatalog = Pick<Store, 'getRepo' | 'getAllWorktreeMeta' | 'getFolderWorkspaces'>

type PathPresence = 'present' | 'absent' | 'unknown'

async function presence(path: string): Promise<PathPresence> {
  try {
    await stat(path)
    return 'present'
  } catch (error) {
    return isDefinitiveAbsence(error) ? 'absent' : 'unknown'
  }
}

/**
 * A worktree directory is gone when it is definitively absent while its parent is still there:
 * an unmounted volume or an unreadable parent says nothing about the worktree.
 */
async function worktreeDirectoryVerdict(
  path: string,
  pathPresence: (path: string) => Promise<PathPresence>
): Promise<NativeChatVisualsWorkspaceVerdict> {
  const own = await pathPresence(path)
  if (own !== 'absent') {
    return own === 'present' ? 'present' : 'unverifiable'
  }
  return (await pathPresence(dirname(path))) === 'present' ? 'removed' : 'unverifiable'
}

export function createNativeChatVisualsWorkspaceVerdict(
  readCatalog: () => WorkspaceCatalog | null,
  pathPresence: (path: string) => Promise<PathPresence> = presence
): (location: AgentSessionExecutionLocation) => Promise<NativeChatVisualsWorkspaceVerdict> {
  return async (location) => {
    // Another host or a WSL distro owns its own answer; loss of contact is never removal.
    if (location.executionHostId !== LOCAL_EXECUTION_HOST_ID || location.wslDistro !== null) {
      return 'unverifiable'
    }
    const { workspaceId } = location
    // The floating workspace names a setting, not a place the user removes.
    if (isFloatingWorkspaceId(workspaceId)) {
      return 'unverifiable'
    }
    const catalog = readCatalog()
    if (!catalog) {
      return 'unverifiable'
    }
    const folder = parseWorkspaceKey(workspaceId)
    if (location.workspaceKind === 'folder') {
      if (folder?.type !== 'folder') {
        return 'unverifiable'
      }
      return catalog
        .getFolderWorkspaces()
        .some((workspace) => folderWorkspaceKey(workspace.id) === workspaceId)
        ? 'present'
        : 'removed'
    }
    const worktree = splitWorktreeIdForFilesystem(workspaceId)
    if (!worktree?.repoId || !worktree.worktreePath) {
      return 'unverifiable'
    }
    // The project itself was removed from Orca.
    if (!catalog.getRepo(worktree.repoId)) {
      return 'removed'
    }
    if (Object.hasOwn(catalog.getAllWorktreeMeta(), workspaceId)) {
      return 'present'
    }
    return worktreeDirectoryVerdict(worktree.worktreePath, pathPresence)
  }
}
