import {
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import { getActiveRuntimeTarget, type RuntimeClientTarget } from './runtime-client-target'

/**
 * The runtime that owns a workspace's structured chats: the paired server the workspace belongs
 * to, else this machine's own runtime (which also answers for its SSH workspaces). Every
 * structured call for the workspace — create included — goes here, so a chat is read from the
 * host that made it.
 */
export function structuredAgentSessionTargetForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string
): RuntimeClientTarget {
  return getActiveRuntimeTarget({
    activeRuntimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  })
}

/** The focus-intent owner key the tab sync for `target` resolves intents under. */
export function structuredAgentSessionFocusOwner(target: RuntimeClientTarget): {
  environmentId: string
} {
  return {
    environmentId: target.kind === 'local' ? LOCAL_STRUCTURED_SESSION_OWNER : target.environmentId
  }
}
