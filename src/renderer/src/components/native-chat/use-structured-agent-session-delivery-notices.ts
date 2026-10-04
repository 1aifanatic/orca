import { useEffect, useMemo, useRef } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { isRecoveredStructuredAgentSessionSubmission } from '../../../../shared/structured-agent-session-unanswered-dispatch'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { useStructuredAgentSessionCommandResultRows } from './use-structured-agent-session-command-result-rows'
import { useStructuredAgentSessionStartFailureFacts } from './use-structured-agent-session-start-failure-facts'

const NO_SUBMISSIONS: readonly AgentJournalSubmission[] = []
const NO_ITEMS: readonly AgentJournalRenderItem[] = []

/** The structured chat's delivery notices, keyed by the message id each row renders under. */
export function useStructuredAgentSessionDeliveryNotices(input: {
  messages: readonly NativeChatMessage[]
  journalItems: readonly AgentJournalRenderItem[]
  submissions: readonly AgentJournalSubmission[]
  outbox: readonly StructuredAgentSessionOutboxEntry[]
  /** The queue's live cards, which hold their own rejected messages. */
  queuedMessageIds: readonly string[]
  agentLabel: string
  /** The agent is working or starting, so a lost outcome may still resolve. */
  agentActive: boolean
}): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const { agentActive, agentLabel, outbox, queuedMessageIds } = input
  // Only a message shown as not sent or not confirmed, or one still in this window's outbox,
  // reads the journal's rows, so a new batch of them re-renders no row else. Read from the
  // transcript and the journal, not this window's outbox: the host's record alone shows one.
  const hasNotSent =
    input.messages.some((message) => message.unsent === true) ||
    input.submissions.some(isRecoveredStructuredAgentSessionSubmission)
  const journalRows = hasNotSent || outbox.length > 0 ? input.submissions : NO_SUBMISSIONS
  // Only an outbox copy of a rejected message reads the loaded rows, so a streaming turn rebuilds
  // no notice otherwise.
  const loadedItems = hasNotSent && outbox.length > 0 ? input.journalItems : NO_ITEMS
  const startFailures = useStructuredAgentSessionStartFailureFacts(input.journalItems, hasNotSent)
  const commandResults = useStructuredAgentSessionCommandResultRows(input.journalItems, hasNotSent)
  const notices = useMemo(
    () =>
      structuredAgentSessionDeliveryNotices(
        outbox,
        agentLabel,
        journalRows,
        startFailures,
        commandResults,
        agentActive,
        queuedMessageIds,
        loadedItems
      ),
    [
      outbox,
      agentLabel,
      journalRows,
      startFailures,
      commandResults,
      agentActive,
      queuedMessageIds,
      loadedItems
    ]
  )
  // A batch rebuilds the map; one that says the same keeps the old, so no row re-renders.
  const previousRef = useRef(notices)
  const stable = sameNoticesKept(previousRef.current, notices)
  useEffect(() => {
    previousRef.current = stable
  }, [stable])
  return stable
}

/** `next`, reusing each notice `previous` words the same way, and `previous` itself when all are. */
function sameNoticesKept(
  previous: ReadonlyMap<string, NativeChatDeliveryNotice>,
  next: ReadonlyMap<string, NativeChatDeliveryNotice>
): ReadonlyMap<string, NativeChatDeliveryNotice> {
  if (previous === next) {
    return next
  }
  let allKept = previous.size === next.size
  const kept = new Map<string, NativeChatDeliveryNotice>()
  for (const [id, notice] of next) {
    const before = previous.get(id)
    const same =
      before !== undefined &&
      before.sending === notice.sending &&
      before.text === notice.text &&
      before.muted === notice.muted &&
      (before.onDismiss === undefined) === (notice.onDismiss === undefined)
    allKept &&= same
    kept.set(id, same ? before : notice)
  }
  return allKept ? previous : kept
}
