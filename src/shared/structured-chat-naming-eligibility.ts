import type { AgentJournalSnapshot } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import { readAgentJournalTurn } from './agent-session-turn-record'
import { isStructuredAgentSessionCommandEntry } from './structured-agent-session-command-entry'
import { firstStructuredAgentSessionPrompt } from './structured-agent-session-first-prompt'

export function firstStructuredChatNamingPrompt(
  snapshot: AgentJournalSnapshot,
  hostStartedAt: number
): string {
  const messages = snapshot.items.filter(
    (item) =>
      item.body.kind === 'message' &&
      item.body.role === 'user' &&
      isRootAgentJournalItem(item) &&
      !isStructuredAgentSessionCommandEntry(item.body)
  )
  const first = messages[0]
  if (messages.length !== 1 || !first) {
    return ''
  }
  const submission = snapshot.submissions.find(
    (send) =>
      send.providerItemId === first.itemId ||
      agentJournalSubmissionKey(send.clientMessageId) === first.itemId
  )
  if (
    !submission ||
    submission.submittedAt < hostStartedAt ||
    submission.recovered ||
    (submission.dispatchState !== 'accepted' && submission.dispatchState !== 'pending')
  ) {
    return ''
  }
  const settled = snapshot.items.some((item) => {
    if (!isRootAgentJournalItem(item)) {
      return false
    }
    const turn = readAgentJournalTurn(item.body)
    const belongsToFirst =
      turn?.userItemId === first.itemId ||
      (first.turnScope?.kind === 'turn' && first.turnScope.turnItemId === item.itemId)
    return belongsToFirst && turn !== null && turn.state !== 'running'
  })
  return settled ? '' : firstStructuredAgentSessionPrompt([first])
}
