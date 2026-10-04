import type { AgentJournalApprovalSubject } from './agent-session-journal-types'

export type ApprovalCardText = {
  blockedPath?: string
  description?: string
  decisionReason?: string
  subject?: AgentJournalApprovalSubject
  detail?: string
}

/** The path an approval needs access to, or null when the card's own text already shows it. */
export function approvalBlockedPathToShow(approval: ApprovalCardText): string | null {
  const path = approval.blockedPath
  if (!path) {
    return null
  }
  // Visible = the path appears verbatim, or JSON-escaped (tool input renders as JSON), in text the card draws.
  const forms = [path, JSON.stringify(path).slice(1, -1)]
  const drawn = approval.subject
    ? [approval.subject.text, approval.subject.filePath]
    : [approval.detail]
  const shown = [approval.description, approval.decisionReason, ...drawn].some(
    (text) => text !== undefined && forms.some((form) => text.includes(form))
  )
  return shown ? null : path
}
