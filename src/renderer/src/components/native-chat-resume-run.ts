import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import type { RestartContinuationOutcome } from './native-chat-restart-action-notifications'

/**
 * One resume as this window ran it: which chats it asked to carry on, and what each answered.
 *
 * Each chat is its own request, so a chat's row settles the moment its own answer arrives rather
 * than when the slowest chat in the batch does. Held in memory for as long as the dialog may show
 * it; the host's offer list stays the record of what is still owed.
 */

/** `gone`: the host no longer offered the chat, e.g. the user answered it first; nothing failed. */
export type ResumeRunResult = 'resumed' | 'refused' | 'unconfirmed' | 'gone'

export type ResumeRunEntry = Readonly<{
  candidate: ResumeCandidate
  startedAt: number
  result?: ResumeRunResult
}>

export type ResumeRun = Readonly<{
  startedAt: number
  /** In the order the chats were asked, so rows keep their place while answers arrive. */
  entries: readonly ResumeRunEntry[]
}>

export function resumeRunInFlight(run: ResumeRun | null): boolean {
  return run?.entries.some((entry) => entry.result === undefined) ?? false
}

/** Chats join a run still in flight; a finished run is replaced, so its rows never linger. */
export function beginResumeRunEntries(
  run: ResumeRun | null,
  candidates: readonly ResumeCandidate[],
  now: number
): ResumeRun {
  const base = run && resumeRunInFlight(run) ? run : { startedAt: now, entries: [] }
  const joining = new Set(candidates.map((candidate) => candidate.sessionId))
  return {
    startedAt: base.startedAt,
    entries: [
      ...base.entries.filter((entry) => !joining.has(entry.candidate.sessionId)),
      ...candidates.map((candidate) => ({ candidate, startedAt: now }))
    ]
  }
}

export function settleResumeRunEntry(
  run: ResumeRun | null,
  sessionId: string,
  result: ResumeRunResult
): ResumeRun | null {
  if (!run) {
    return run
  }
  return {
    ...run,
    entries: run.entries.map((entry) =>
      entry.candidate.sessionId === sessionId && entry.result === undefined
        ? { ...entry, result }
        : entry
    )
  }
}

/**
 * One chat's own answer, read the way the toast reads it: an unconfirmed send the host stopped
 * listing was seen carrying on, and a chat the host acted on without a verdict is unconfirmed.
 */
export function resumeRunResultOf(
  sessionId: string,
  continued: readonly RestartContinuationOutcome[] | undefined,
  failed: readonly Pick<ResumeFailure, 'sessionId' | 'outcome'>[] | undefined
): ResumeRunResult {
  const listed = failed?.find((failure) => failure.sessionId === sessionId)
  if (listed) {
    return listed.outcome
  }
  const outcome = continued?.find((entry) => entry.sessionId === sessionId)?.outcome
  if (outcome === 'continued') {
    return 'resumed'
  }
  if (outcome === 'pending' || outcome === 'unknown') {
    return failed === undefined ? 'unconfirmed' : 'resumed'
  }
  if (outcome === 'refused') {
    return failed === undefined ? 'refused' : 'gone'
  }
  // No verdict for it at all: an answer without outcomes may still have sent the message.
  return continued === undefined ? 'unconfirmed' : 'gone'
}

/** Ids still waiting on their own answer; one shared empty array keeps the snapshot stable. */
const NONE: readonly string[] = []
export function resumeRunPendingIds(run: ResumeRun | null): readonly string[] {
  const pending = run?.entries.filter((entry) => entry.result === undefined) ?? []
  return pending.length === 0 ? NONE : pending.map((entry) => entry.candidate.sessionId)
}
