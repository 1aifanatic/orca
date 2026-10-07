import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import type { ResumeRun } from './native-chat-resume-run'

/**
 * What the dialog shows while it follows a run: one row per chat, each with where it stands.
 *
 * Pure, so the ordering and the counts are tested without a store. A chat the host already lists as
 * failed is shown as that failure row, with its guidance and Retry, rather than as a bare status.
 */

/** Where one chat of the run stands, as the leading icon shows it in place of the checkbox. */
export type ResumeRunRowStatus =
  | { kind: 'in-flight'; startedAt: number }
  | { kind: 'resumed' }
  | { kind: 'refused' }
  | { kind: 'unconfirmed' }

export type ResumeRunFilter = 'all' | 'in-progress' | 'resumed' | 'attention'

type Category = Exclude<ResumeRunFilter, 'all'> | 'other'

export type ResumeRunView = {
  rows: ResumeCandidate[]
  statusBySession: ReadonlyMap<string, ResumeRunRowStatus>
  counts: Readonly<{
    /** Every row the list holds, in the run or not. */
    all: number
    /** Chats in this run that still need resuming or did; a chat nobody needed is not counted. */
    total: number
    done: number
    inProgress: number
    resumed: number
    /** Failed or unconfirmed, this run's or an earlier one's: the rows that need the user. */
    attention: number
  }>
}

// What needs the user first, then what is still moving, then what is done.
const ORDER: Record<Category, number> = { attention: 0, 'in-progress': 1, resumed: 2, other: 3 }

export function resumeRunView(
  run: ResumeRun,
  listed: readonly ResumeCandidate[],
  failureFor: (sessionId: string) => ResumeFailure | undefined,
  filter: ResumeRunFilter
): ResumeRunView {
  const listedById = new Map(listed.map((row) => [row.sessionId, row]))
  const statusBySession = new Map<string, ResumeRunRowStatus>()
  const placed: { row: ResumeCandidate; category: Category; index: number }[] = []
  const inRun = new Set<string>()
  for (const entry of run.entries) {
    const { sessionId } = entry.candidate
    inRun.add(sessionId)
    if (entry.result === 'gone') {
      continue
    }
    const row = listedById.get(sessionId) ?? entry.candidate
    if (entry.result === undefined) {
      statusBySession.set(sessionId, { kind: 'in-flight', startedAt: entry.startedAt })
      placed.push({ row, category: 'in-progress', index: placed.length })
    } else if (entry.result === 'resumed') {
      statusBySession.set(sessionId, { kind: 'resumed' })
      placed.push({ row, category: 'resumed', index: placed.length })
    } else {
      // Until the host lists it, the run's own answer is all there is to show.
      if (!failureFor(sessionId)) {
        statusBySession.set(sessionId, { kind: entry.result })
      }
      placed.push({ row, category: 'attention', index: placed.length })
    }
  }
  for (const row of listed) {
    if (!inRun.has(row.sessionId)) {
      const category = failureFor(row.sessionId) ? 'attention' : 'other'
      placed.push({ row, category, index: placed.length })
    }
  }
  const count = (category: Category) => placed.filter((entry) => entry.category === category).length
  const inRunCount = placed.filter((entry) => inRun.has(entry.row.sessionId)).length
  const inProgress = count('in-progress')
  return {
    rows: placed
      .filter((entry) => filter === 'all' || entry.category === filter)
      .sort((a, b) => ORDER[a.category] - ORDER[b.category] || a.index - b.index)
      .map((entry) => entry.row),
    statusBySession,
    counts: {
      all: placed.length,
      total: inRunCount,
      done: inRunCount - inProgress,
      inProgress,
      resumed: count('resumed'),
      attention: count('attention')
    }
  }
}
