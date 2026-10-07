import {
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import { isNativeChatTabScopeCurrent, type NativeChatBridgeTabScope } from './native-chat-tab-scope'

export type NativeChatRuntimeOwnerState = Pick<AppState, 'tabsByWorktree'> &
  WorktreeRuntimeOwnerState

/**
 * The runtime owner id for a Native Chat pane, as a primitive — non-null only for
 * `runtime:` hosts (Model B), null for local and `ssh:` (Model A stays local).
 *
 * KTD-1: intentionally decoupled from `resolveNativeChatFileLinkContext`, which
 * returns null whenever the worktree *path* can't resolve (store hydration, folder
 * scopes, a remote worktree whose path hasn't landed). In that window the owner is
 * still knowable and the transport must route to the runtime — reusing the
 * path-coupled context would fall back to local session data, the exact bug this
 * kills. Resolve the owner from the supplied workspace alone; do not merge the
 * two selections.
 */
export function selectNativeChatRuntimeEnvironmentId(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string
): string | null {
  return getRuntimeEnvironmentIdForWorktree(state, worktreeId)
}

/**
 * Whether a bridge chat's tab is still in its workspace. Null owner already means "local", so a
 * miss is reported separately and must suspend transcript IO rather than read locally.
 */
export function selectNativeChatBridgeMembership(
  state: Pick<AppState, 'tabsByWorktree'>,
  scope: NativeChatBridgeTabScope
): boolean {
  return isNativeChatTabScopeCurrent(state, scope)
}
