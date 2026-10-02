import type { z } from 'zod'
import type { WorktreeCreateTiming } from '../../../../shared/worktree/create-types'
import {
  WORKTREE_CREATE_PHASES,
  type WorktreeCreatePhase
} from '../../../../shared/worktree/create-timing-vocabulary'
import type {
  POST_CHECKOUT_HOOK_PRESENCE_VALUES,
  WORKTREE_COUNT_BUCKETS,
  workspaceCreateFailureShape,
  workspaceCreateTimingShape
} from '../../../../shared/telemetry-workspace-create-schemas'
import type { WorktreeCreateTimingRecorder } from '../../../worktree-create-timing'
import { worktreeCreateUnattributedMs } from '../../../observability/instrumentation'

type ShapeProps<S extends z.ZodRawShape> = { [K in keyof S]?: z.infer<S[K]> }
export type WorkspaceCreateTimingFields = ShapeProps<typeof workspaceCreateTimingShape>
export type WorkspaceCreateFailureFields = ShapeProps<typeof workspaceCreateFailureShape>
type WorktreeCountBucket = (typeof WORKTREE_COUNT_BUCKETS)[number]
type PostCheckoutHookPresence = (typeof POST_CHECKOUT_HOOK_PRESENCE_VALUES)[number]

const KNOWN_PHASES: ReadonlySet<string> = new Set(WORKTREE_CREATE_PHASES)

function isKnownPhase(phase: string): phase is WorktreeCreatePhase {
  return KNOWN_PHASES.has(phase)
}

export function bucketWorktreeCount(count: number): WorktreeCountBucket {
  if (count <= 1) {
    return '1'
  }
  if (count <= 5) {
    return '2-5'
  }
  if (count <= 20) {
    return '6-20'
  }
  if (count <= 100) {
    return '21-100'
  }
  if (count <= 300) {
    return '101-300'
  }
  return count <= 1000 ? '301-1000' : '1001+'
}

function phaseDurationFields(phases: WorktreeCreateTiming['phases']): WorkspaceCreateTimingFields {
  const totals = new Map<WorktreeCreatePhase, number>()
  for (const phase of phases) {
    // Unknown names are dropped rather than forwarded: only the closed vocabulary may leave.
    if (isKnownPhase(phase.phase)) {
      totals.set(phase.phase, (totals.get(phase.phase) ?? 0) + phase.durationMs)
    }
  }
  const fields: WorkspaceCreateTimingFields = {}
  for (const [phase, durationMs] of totals) {
    fields[`${phase}_ms`] = Math.round(durationMs)
  }
  return fields
}

/** Event fields for a finished create, built only from what the create already measured. */
export function workspaceCreateTimingFields(
  timing: WorktreeCreateTiming,
  context: { concurrentCreates: number; postCheckoutHook?: PostCheckoutHookPresence }
): WorkspaceCreateTimingFields {
  const prepared = timing.preparedCheckout
  return {
    total_ms: Math.round(timing.totalDurationMs),
    unattributed_ms: worktreeCreateUnattributedMs(timing),
    ...phaseDurationFields(timing.phases),
    ...(prepared?.status === 'hit'
      ? { prepared_checkout: 'hit', prepared_checkout_retargeted: prepared.retargeted }
      : prepared
        ? { prepared_checkout: 'miss', prepared_checkout_miss_reason: prepared.reason }
        : {}),
    ...(timing.executionHost ? { execution_host: timing.executionHost } : {}),
    ...(timing.worktreeCount !== undefined
      ? { worktree_count_bucket: bucketWorktreeCount(timing.worktreeCount) }
      : {}),
    concurrent_creates: context.concurrentCreates,
    ...(context.postCheckoutHook ? { post_checkout_hook: context.postCheckoutHook } : {})
  }
}

/** Event fields for a failed create: where it died and how long it had run. */
export function workspaceCreateFailureFields(
  recorder: Pick<WorktreeCreateTimingRecorder, 'failedPhase' | 'finish'>,
  context: { concurrentCreates: number; error: unknown }
): WorkspaceCreateFailureFields {
  const timing = recorder.finish()
  return {
    failed_phase: recorder.failedPhase(context.error) ?? 'untimed',
    total_ms: Math.round(timing.totalDurationMs),
    ...(timing.executionHost ? { execution_host: timing.executionHost } : {}),
    concurrent_creates: context.concurrentCreates
  }
}
