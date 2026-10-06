import {
  isAgentSessionConversationCommand,
  type AgentSessionConversationCommand,
  type AgentSessionConversationCommandResult
} from '../../../../shared/agent-session-conversation-command'
import {
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../../shared/agent-session-failure'
import { agentSessionFailureSentence } from '../../../../shared/agent-session-failure-words'
import { translate } from '@/i18n/i18n'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import {
  agentSessionFailureStatedByStartRow,
  structuredAgentSessionDeliveryNotices
} from './structured-agent-session-delivery-notices'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import {
  structuredAgentSessionEntryRejectedByHost,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { hasUnsentStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox-stop-withdrawal'
import type { StructuredAgentSessionWriteOutcome } from './use-structured-agent-session-mutate'

/** Why this client does not send the command yet. `ahead`: a message this window sent is not
 *  the host's yet; the command is not taken, and its text stays in the composer while Send is
 *  busy, as for any send on its way. The rest are refused here, in words. */
export type StructuredConversationCommandHold =
  | 'ahead'
  | 'working'
  | 'prompt'
  | 'background'
  | 'retry'
  | 'sending'

/** A command that waits in line is held only by a message the host doesn't have yet, which must
 *  stay ahead of it; any other command, by anything the agent still has in flight. */
export function structuredConversationCommandHold(input: {
  /** A /compact or /clear the host can hold as a card behind the turn or prompt. */
  waitsInLine: boolean
  /** A turn runs, or the chat shows the agent working on a message it has not answered. */
  agentWorking: boolean
  promptPending: boolean
  backgroundTasksRunning: boolean
  /** A message this window sent shows its Retry on its row. */
  outboxRetry: boolean
  /** A message this window sent is still on its way with no Retry on its row (one a Stop kept). */
  outboxSending: boolean
  /** A message this window sent that the host doesn't have yet. */
  outboxUnsent: boolean
}): StructuredConversationCommandHold | null {
  if (input.backgroundTasksRunning) {
    return 'background'
  }
  if (input.waitsInLine) {
    return input.outboxUnsent ? 'ahead' : null
  }
  if (input.promptPending) {
    return 'prompt'
  }
  if (input.agentWorking || input.outboxUnsent) {
    return 'working'
  }
  // The agent is not working: what is left is said as its row says it.
  if (input.outboxRetry) {
    return 'retry'
  }
  return input.outboxSending ? 'sending' : null
}

/** The line a command refused here gets: what the person sees and can do, as the host says it. */
function heldCommandText(
  command: AgentSessionConversationCommand,
  hold: Exclude<StructuredConversationCommandHold, 'ahead'>
): string {
  const clear = command === 'clear'
  switch (hold) {
    case 'prompt':
      return agentSessionWriteNoticeText([clear ? 'clearAfterAnswer' : 'compactAfterAnswer'])
    case 'working':
      return agentSessionWriteNoticeText([
        'agentStillWorking',
        clear ? 'runClearWhenDone' : 'runCompactWhenDone'
      ])
    case 'retry':
      return agentSessionWriteNoticeText([clear ? 'clearAfterRetry' : 'compactAfterRetry'])
    case 'sending':
      return agentSessionWriteNoticeText([clear ? 'clearAfterSending' : 'compactAfterSending'])
    case 'background':
      break
  }
  return translate(
    'components.native-chat.conversationCommand.pendingWork',
    'Wait for pending work and messages to finish before using this command.'
  )
}

export async function sendStructuredConversationCommand(input: {
  command: AgentSessionConversationCommand
  /** The chat's agent, as a failed command names it. */
  agentName: string
  pending: { current: boolean }
  hold: StructuredConversationCommandHold | null
  /** What the chat's loaded start-failure rows state, read when the reply lands. */
  startFailures: () => readonly AgentSessionFailureFact[]
  send: (
    command: AgentSessionConversationCommand
  ) => Promise<StructuredAgentSessionWriteOutcome<AgentSessionConversationCommandResult>>
}): Promise<{ accepted: boolean; error: string | null }> {
  // A command on its way is the agent's work in flight.
  if (input.pending.current) {
    return { accepted: false, error: heldCommandText(input.command, 'working') }
  }
  // The message ahead reads as sending, and Send is busy until the host has it; nothing is armed.
  if (input.hold === 'ahead') {
    return { accepted: false, error: null }
  }
  if (input.hold !== null) {
    return { accepted: false, error: heldCommandText(input.command, input.hold) }
  }
  input.pending.current = true
  try {
    const outcome = await input.send(input.command)
    if (outcome.kind === 'not-done') {
      return { accepted: false, error: outcome.notice }
    }
    // The pane stopped waiting on this reply (closed, left the chat, or sent a newer command).
    if (outcome.kind === 'dropped') {
      return { accepted: false, error: null }
    }
    const { value } = outcome
    // The chat's own start failed and its loaded row already says why, as for a message that start
    // rejected. A /clear's failed start is its new chat's, whose row this pane never shows, and a
    // command this build doesn't know may be either, so its host's words are shown.
    if (
      isAgentSessionConversationCommand(value.command) &&
      value.command !== 'clear' &&
      agentSessionFailureStatedByStartRow(value.failure, input.startFailures())
    ) {
      return { accepted: false, error: null }
    }
    const error = conversationCommandFailureText(value, input.agentName)
    return { accepted: value.state === 'completed' && !error, error }
  } finally {
    input.pending.current = false
  }
}

/** The composer's /clear or /compact, with what this pane knows about work in flight. */
export function structuredConversationCommandRunner(args: {
  agentName: string
  pending: { current: boolean }
  /** The host holds a /compact as a card, and this client renders the queue. */
  commandsWait: boolean
  /** The same for a /clear, which the host runs itself when its card's turn comes. An older host
   *  refuses it while the agent works (temporary, until those hosts age out). */
  clearWaits?: boolean
  /** The chat shows the agent working: a turn runs, or a message it has not answered. */
  agentWorking: boolean
  promptPending: boolean
  /** Every pending prompt is one this build cannot answer: a card would wait on it forever. */
  promptsUnanswerableHere: boolean
  backgroundTasksRunning: boolean
  outbox: readonly StructuredAgentSessionOutboxEntry[]
  submissions: readonly AgentJournalSubmission[]
  startFailures: () => readonly AgentSessionFailureFact[]
  write: (
    fields: Record<string, unknown>
  ) => Promise<StructuredAgentSessionWriteOutcome<AgentSessionConversationCommandResult>>
}): (
  command: AgentSessionConversationCommand
) => Promise<{ accepted: boolean; error: string | null }> {
  return (command) => {
    const hostHoldsIt = command === 'compact' ? args.commandsWait : args.clearWaits === true
    const waitsInLine = hostHoldsIt && !(args.promptPending && args.promptsUnanswerableHere)
    return sendStructuredConversationCommand({
      command,
      agentName: args.agentName,
      pending: args.pending,
      hold: structuredConversationCommandHold({
        waitsInLine,
        agentWorking: args.agentWorking,
        promptPending: args.promptPending,
        backgroundTasksRunning: args.backgroundTasksRunning,
        ...outboxRows(args.outbox, args.submissions, args.agentName),
        outboxUnsent: hasUnsentStructuredAgentSessionOutboxEntry(args.outbox, args.submissions)
      }),
      startFailures: args.startFailures,
      send: (command) =>
        args.write(hostHoldsIt ? { command, delivery: 'queue-if-active' } : { command })
    })
  }
}

/** What this window's own messages offer on their rows: a Retry, or nothing while still on
 *  their way. One the host already refused is the host's row, and holds nothing up. */
function outboxRows(
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  agentName: string
): { outboxRetry: boolean; outboxSending: boolean } {
  if (outbox.length === 0) {
    return { outboxRetry: false, outboxSending: false }
  }
  const notices = structuredAgentSessionDeliveryNotices(
    outbox,
    agentName,
    () => {},
    submissions,
    [],
    new Set()
  )
  const offersRetry = (entry: StructuredAgentSessionOutboxEntry) =>
    notices.get(agentJournalSubmissionKey(entry.clientMessageId))?.onRetry !== undefined
  return {
    outboxRetry: outbox.some(offersRetry),
    outboxSending: outbox.some(
      (entry) => !offersRetry(entry) && !structuredAgentSessionEntryRejectedByHost(entry)
    )
  }
}

/** The host's sentence in the reader's language, from the fact beside it; with no fact (an older
 *  host), one this build can't read whole, or a command it doesn't know, the sentence as written. */
function conversationCommandFailureText(
  result: AgentSessionConversationCommandResult,
  agentName: string
): string | null {
  const fact = isAgentSessionConversationCommand(result.command)
    ? readWholeAgentSessionFailureFact(result.failure)
    : undefined
  if (!fact) {
    return result.error ?? null
  }
  // As the host words it: naming the chat's agent and the command a failed start was for.
  return agentSessionFailureSentence(
    fact,
    'row',
    { agentName, command: result.command },
    sayAgentSessionFailureTranslated
  )
}
