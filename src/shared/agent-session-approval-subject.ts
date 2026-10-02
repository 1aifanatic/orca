// An approval subject of a kind this build cannot draw is a newer Orca's. It is carried as it was,
// its card shows the approval's `detail`, and only the card's cancel answers it: nobody approves
// what this build cannot show. On Claude the cancel denies the request and the turn goes on; on
// Codex it ends the turn.

import type {
  AgentJournalApprovalSubject,
  AgentJournalPlanApprovalSubject
} from './agent-session-journal-types'

/** The subject kinds this build draws: the known arms of the journal schema's approval subject.
 *  A copy, kept equal by a test, so clients that never load the schema module can read it. */
export const DRAWN_APPROVAL_SUBJECT_KINDS: ReadonlySet<string> = new Set(['plan'])

export function isPlanApprovalSubject(
  subject: AgentJournalApprovalSubject | undefined
): subject is AgentJournalPlanApprovalSubject {
  return subject?.kind === 'plan'
}

export function isNewerApprovalSubject(subject: { kind: string } | undefined): boolean {
  return subject !== undefined && !DRAWN_APPROVAL_SUBJECT_KINDS.has(subject.kind)
}
