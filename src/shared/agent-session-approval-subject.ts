// An approval subject of a kind this build cannot draw is a newer Orca's. Its card shows the
// approval's `detail` and offers only the cancel that ends the turn: nobody approves what this
// build cannot show.

/** The subject kinds this build draws: the known arms of the journal schema's approval subject. */
export const DRAWN_APPROVAL_SUBJECT_KINDS: ReadonlySet<string> = new Set(['plan'])

export function isNewerApprovalSubject(subject: { kind: string } | undefined): boolean {
  return subject !== undefined && !DRAWN_APPROVAL_SUBJECT_KINDS.has(subject.kind)
}
