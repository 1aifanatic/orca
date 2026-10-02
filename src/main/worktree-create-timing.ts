import type {
  PreparedCheckoutOutcome,
  WorktreeCreateExecutionHost,
  WorktreeCreateTiming,
  WorktreeCreateTimingPhase
} from '../shared/worktree/create-types'
import type { WorktreeCreatePhase } from '../shared/worktree/create-timing-vocabulary'

type TimingClock = () => number

export type WorktreeCreateTimingRecorder = {
  time<T>(phase: WorktreeCreatePhase, operation: () => Promise<T>): Promise<T>
  timeSync<T>(phase: WorktreeCreatePhase, operation: () => T): T
  recordPreparedCheckout(outcome: PreparedCheckoutOutcome): void
  recordExecutionHost(host: WorktreeCreateExecutionHost): void
  recordWorktreeCount(count: number): void
  /** The phase a failed create died in; undefined when it failed outside every timed phase. */
  failedPhase(): WorktreeCreatePhase | undefined
  finish(): WorktreeCreateTiming
}

function defaultClock(): number {
  return performance.now()
}

function clampDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function createPhase(
  phase: WorktreeCreatePhase,
  operationStartedAt: number,
  operationEndedAt: number,
  rootStartedAt: number
): WorktreeCreateTimingPhase {
  return {
    phase,
    startedAtMs: clampDuration(operationStartedAt - rootStartedAt),
    durationMs: clampDuration(operationEndedAt - operationStartedAt)
  }
}

export function createWorktreeCreateTimingRecorder(
  clock: TimingClock = defaultClock
): WorktreeCreateTimingRecorder {
  const startedAt = clock()
  const phases: WorktreeCreateTimingPhase[] = []
  let preparedCheckout: PreparedCheckoutOutcome | undefined
  let executionHost: WorktreeCreateExecutionHost | undefined
  let worktreeCount: number | undefined
  // Sequence numbers order phase starts against failures without trusting clock resolution.
  let sequence = 0
  let failure: { phase: WorktreeCreatePhase; sequence: number } | undefined

  const recordPhase = (phase: WorktreeCreatePhase, operationStartedAt: number): void => {
    phases.push(createPhase(phase, operationStartedAt, clock(), startedAt))
  }
  const beginPhase = (): number => {
    // A new phase starting means any earlier failure was caught and the create moved on.
    failure = undefined
    return ++sequence
  }
  const endPhase = (phase: WorktreeCreatePhase, phaseSequence: number, threw: boolean): void => {
    if (threw) {
      // An enclosing phase that rethrows is the more accurate place to name than its inner step.
      failure = { phase, sequence: ++sequence }
    } else if (failure && phaseSequence < failure.sequence) {
      // An enclosing phase that survived an inner failure (e.g. a prepared-checkout fallback).
      failure = undefined
    }
  }

  return {
    async time<T>(phase: WorktreeCreatePhase, operation: () => Promise<T>): Promise<T> {
      const operationStartedAt = clock()
      const phaseSequence = beginPhase()
      let threw = true
      try {
        const result = await operation()
        threw = false
        return result
      } finally {
        endPhase(phase, phaseSequence, threw)
        recordPhase(phase, operationStartedAt)
      }
    },
    timeSync<T>(phase: WorktreeCreatePhase, operation: () => T): T {
      const operationStartedAt = clock()
      const phaseSequence = beginPhase()
      let threw = true
      try {
        const result = operation()
        threw = false
        return result
      } finally {
        endPhase(phase, phaseSequence, threw)
        recordPhase(phase, operationStartedAt)
      }
    },
    recordPreparedCheckout(outcome: PreparedCheckoutOutcome): void {
      preparedCheckout = outcome
    },
    recordExecutionHost(host: WorktreeCreateExecutionHost): void {
      executionHost = host
    },
    recordWorktreeCount(count: number): void {
      worktreeCount = count
    },
    failedPhase() {
      return failure?.phase
    },
    finish() {
      return {
        totalDurationMs: clampDuration(clock() - startedAt),
        phases: [...phases],
        ...(preparedCheckout ? { preparedCheckout } : {}),
        ...(executionHost ? { executionHost } : {}),
        ...(worktreeCount !== undefined ? { worktreeCount } : {})
      }
    }
  }
}
