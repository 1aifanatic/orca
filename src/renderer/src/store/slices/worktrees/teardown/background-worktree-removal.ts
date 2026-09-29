import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../../../shared/worktree/create-types'
import type { WorktreeRemovalOutcome } from '../../../../../../shared/worktree/removal-outcome'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { RuntimeClientTarget } from '../../../../runtime/runtime-client-target'

type Waiter = {
  worktreeId: string
  hostId: ExecutionHostId
  accepted: RemoveWorktreeResult
  knownToRenderer: boolean
  observedRemoving: boolean
  resolve: (result: RemoveWorktreeResult) => void
  reject: (error: Error) => void
}

// Why: on a runtime connection the outcome event and the acceptance reply travel separately, so a
// fast failure can land first; keep it long enough for the waiter that is about to register.
const EARLY_OUTCOME_TTL_MS = 60_000

type RemovalRow = Pick<Worktree, 'id' | 'hostId' | 'removing'>
type RowsLookup = (worktreeId: string) => readonly RemovalRow[]

const waiters = new Map<string, Waiter>()
// Why injected: this slice cannot import the store; the app bridge that watches listings supplies it.
let rowsLookup: RowsLookup | null = null
const earlyOutcomes = new Map<string, { outcome: WorktreeRemovalOutcome; expiresAt: number }>()

function removalKey(hostId: ExecutionHostId, worktreeId: string): string {
  return `${hostId}\0${worktreeId}`
}

/** The host id this renderer files rows from `target` under, which is what outcomes are keyed by. */
export function backgroundRemovalHostId(target: RuntimeClientTarget): ExecutionHostId {
  return target.kind === 'local'
    ? LOCAL_EXECUTION_HOST_ID
    : toRuntimeExecutionHostId(target.environmentId)
}

export function rowHostId(row: Pick<Worktree, 'hostId'>): ExecutionHostId {
  return row.hostId ?? LOCAL_EXECUTION_HOST_ID
}

export function setBackgroundWorktreeRemovalRowsLookup(lookup: RowsLookup | null): void {
  rowsLookup = lookup
}

function findRow(
  rows: readonly RemovalRow[],
  hostId: ExecutionHostId,
  worktreeId: string
): RemovalRow | undefined {
  return rows.find((row) => row.id === worktreeId && rowHostId(row) === hostId)
}

function finishedResult(
  accepted: RemoveWorktreeResult,
  outcome: WorktreeRemovalOutcome
): RemoveWorktreeResult {
  if (outcome.status === 'failed') {
    throw new Error(outcome.error)
  }
  const { removing: _removing, catalogVersion: _acceptedVersion, ...rest } = accepted
  return {
    ...rest,
    ...(outcome.preservedBranch ? { preservedBranch: outcome.preservedBranch } : {}),
    ...(outcome.catalogVersion ? { catalogVersion: outcome.catalogVersion } : {})
  }
}

/**
 * Resolves when the host finishes a removal it accepted in the background, with the result an
 * inline removal would have returned, or rejects with the host's error.
 */
export function waitForBackgroundWorktreeRemoval(args: {
  hostId: ExecutionHostId
  worktreeId: string
  accepted: RemoveWorktreeResult
}): Promise<RemoveWorktreeResult> {
  const key = removalKey(args.hostId, args.worktreeId)
  const early = earlyOutcomes.get(key)
  earlyOutcomes.delete(key)
  if (early && early.expiresAt > Date.now()) {
    try {
      return Promise.resolve(finishedResult(args.accepted, early.outcome))
    } catch (error) {
      return Promise.reject(error)
    }
  }
  return new Promise((resolve, reject) => {
    waiters.get(key)?.reject(new Error('Superseded by a newer delete of this workspace.'))
    waiters.set(key, {
      worktreeId: args.worktreeId,
      hostId: args.hostId,
      accepted: args.accepted,
      // Only a row this renderer listed can prove the delete finished by disappearing.
      knownToRenderer:
        findRow(rowsLookup?.(args.worktreeId) ?? [], args.hostId, args.worktreeId) !== undefined,
      observedRemoving: false,
      resolve,
      reject
    })
  })
}

/** Returns false when no removal in this renderer was waiting on the outcome. */
export function settleBackgroundWorktreeRemoval(
  hostId: ExecutionHostId,
  outcome: WorktreeRemovalOutcome
): boolean {
  const key = removalKey(hostId, outcome.worktreeId)
  const waiter = waiters.get(key)
  if (!waiter) {
    const now = Date.now()
    for (const [earlyKey, early] of earlyOutcomes) {
      if (early.expiresAt <= now) {
        earlyOutcomes.delete(earlyKey)
      }
    }
    earlyOutcomes.set(key, { outcome, expiresAt: now + EARLY_OUTCOME_TTL_MS })
    return false
  }
  waiters.delete(key)
  try {
    waiter.resolve(finishedResult(waiter.accepted, outcome))
  } catch (error) {
    waiter.reject(error instanceof Error ? error : new Error(String(error)))
  }
  return true
}

/**
 * Settles waiters from listings when the outcome event never arrives (a dropped runtime
 * connection): a row seen removing that then vanishes finished, one that returns unmarked did not.
 */
export function settleBackgroundWorktreeRemovalsFromRows(rowsFor: RowsLookup): void {
  for (const [key, waiter] of waiters) {
    const row = findRow(rowsFor(waiter.worktreeId), waiter.hostId, waiter.worktreeId)
    if (row?.removing) {
      waiter.observedRemoving = true
      continue
    }
    if (!row && (waiter.observedRemoving || waiter.knownToRenderer)) {
      waiters.delete(key)
      const { removing: _removing, catalogVersion: _acceptedVersion, ...rest } = waiter.accepted
      waiter.resolve(rest)
      continue
    }
    if (row && waiter.observedRemoving) {
      waiters.delete(key)
      waiter.reject(new Error('The delete did not finish. Try again.'))
    }
  }
}

export function _resetBackgroundWorktreeRemovalsForTests(): void {
  waiters.clear()
  earlyOutcomes.clear()
  rowsLookup = null
}
