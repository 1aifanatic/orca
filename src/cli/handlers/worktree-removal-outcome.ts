import type { RuntimeWorktreeRemoveResult } from '../../shared/runtime-types'
import { WORKTREE_REMOVAL_WAIT_LIMIT_MS } from '../../shared/worktree/removal'
import { RuntimeClientError, type RuntimeClient, type RuntimeRpcSuccess } from '../runtime-client'

// Why: the host bounds the wait itself and answers `waitExpired`; this only catches a host that
// stops answering altogether, so it must outlast the host's own limit.
export const WORKTREE_REMOVAL_WAIT_TIMEOUT_MS = WORKTREE_REMOVAL_WAIT_LIMIT_MS + 60_000

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
 * has finished, a non-zero error if it failed or is still running past the wait. A host that
 * predates `waitForRemoval` still answers on acceptance with `removing: true`; that is reported
 * as not yet removed rather than as a removal.
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
      throw isRuntimeTimeout(error) ? unansweredRemovalError(request.worktree) : error
    })
  if (response.result.waitExpired) {
    throw stillRunningError(request.worktree)
  }
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
function stillRunningError(worktree: string): RuntimeClientError {
  return new RuntimeClientError(
    'worktree_removal_still_running',
    `Orca is still removing ${worktree}; it did not finish within ${WORKTREE_REMOVAL_WAIT_LIMIT_MS / 60_000} minutes. Check \`orca worktree show --worktree ${worktree}\` before retrying.`
  )
}

// Why: only a host that stops answering reaches this; it may not have started the delete at all.
function unansweredRemovalError(worktree: string): RuntimeClientError {
  return new RuntimeClientError(
    'worktree_removal_still_running',
    `Orca stopped answering while removing ${worktree}; the removal may still be running. Check \`orca worktree show --worktree ${worktree}\` before retrying.`
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
