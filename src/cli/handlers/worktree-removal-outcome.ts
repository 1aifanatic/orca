import type { RuntimeWorktreeRemoveResult } from '../../shared/runtime-types'
import { RuntimeClientError, type RuntimeClient, type RuntimeRpcSuccess } from '../runtime-client'

// Why: the reply now waits out Git's checkout delete (20-35 s on a large repo, after the PTY
// sweep), which the 60 s default request timeout does not reliably cover.
export const WORKTREE_REMOVAL_WAIT_TIMEOUT_MS = 5 * 60_000

export type WorktreeRemovalRequest = {
  worktree: string
  hostId: string
  force: boolean
  allowUnverifiedPtyStop: boolean
  runHooks: boolean
  allowFailedArchiveHook: boolean
}

/**
 * Removes the worktree and answers with the delete's outcome: `removed: true` only once Git
 * has finished. A host that predates `waitForRemoval` still answers on acceptance with
 * `removing: true`; that is reported as not yet removed rather than as a removal.
 */
export async function removeWorktreeAndWait(
  client: RuntimeClient,
  request: WorktreeRemovalRequest
): Promise<RuntimeRpcSuccess<RuntimeWorktreeRemoveResult>> {
  const response = await client
    .call<RuntimeWorktreeRemoveResult>(
      'worktree.rm',
      { ...request, waitForRemoval: true },
      { timeoutMs: WORKTREE_REMOVAL_WAIT_TIMEOUT_MS }
    )
    .catch((error: unknown) => {
      throw describeUnfinishedRemoval(error, request.worktree)
    })
  return response.result.removing
    ? { ...response, result: { ...response.result, removed: false } }
    : response
}

export function formatWorktreeRemoval(value: RuntimeWorktreeRemoveResult): string {
  return value.removing
    ? 'removed: false\nOrca accepted the removal and is still deleting the checkout; this Orca version does not report when it finishes.'
    : `removed: ${value.removed}`
}

/** A wait that ran out says the removal may still be running, not that it failed. */
function describeUnfinishedRemoval(error: unknown, worktree: string): unknown {
  if (!isRuntimeTimeout(error)) {
    return error
  }
  return new RuntimeClientError(
    'worktree_removal_still_running',
    `Orca did not report the outcome of removing ${worktree} within ${WORKTREE_REMOVAL_WAIT_TIMEOUT_MS / 60_000} minutes. The removal may still be running; check \`orca worktree show --worktree ${worktree}\` before retrying.`
  )
}

function isRuntimeTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'runtime_timeout'
  )
}
