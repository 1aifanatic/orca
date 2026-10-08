import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'
import type { RestartContinuationOutcome } from './native-chat-restart-action-notifications'

/** Selection and history belong to this window; live progress and failures belong to the host. */
export type ResumeRun = Readonly<{
  startedAt: number
  entries: readonly Readonly<{ candidate: ResumeCandidate }>[]
  inFlight: boolean
  continued?: readonly RestartContinuationOutcome[]
}>

export function resumeRunInFlight(run: ResumeRun | null): boolean {
  return run?.inFlight ?? false
}

export function beginResumeRun(candidates: readonly ResumeCandidate[], now: number): ResumeRun {
  return { startedAt: now, entries: candidates.map((candidate) => ({ candidate })), inFlight: true }
}

const NONE: readonly string[] = []
/** Keep the selection protected until the action's authoritative reply has been published. */
export function resumeRunPendingIds(run: ResumeRun | null): readonly string[] {
  return run?.inFlight ? run.entries.map((entry) => entry.candidate.sessionId) : NONE
}
