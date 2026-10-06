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
  structuredAgentSessionDeliveryNotices,
  structuredAgentSessionStartFailureFacts
} from './structured-agent-session-delivery-notices'
import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session-approval-subject'
import type { StructuredPromptItem } from './structured-agent-session-message-projection'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import {
  structuredAgentSessionEntryRejectedByHost,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { hasUnsentStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox-stop-withdrawal'
import { structuredAgentSessionCommandHostRefusalCause } from '../../../../shared/structured-agent-session-command-refusal-cause'
import type {
  StructuredAgentSessionCommandOutcome,
  StructuredAgentSessionCommandRefusalCause
} from '../../../../shared/structured-agent-session-composer'
import type {
  StructuredAgentSessionWrite,
  StructuredAgentSessionWriteOutcome
} from './use-structured-agent-session-mutate'

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
  /** A /compact the host can hold as a card behind the turn or prompt. */
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
  if (input.agentWorking) {
    return 'working'
  }
  // The agent is idle and this window's own message hasn't reached the host: that is the wait.
  if (input.outboxUnsent) {
    return 'sending'
  }
  // The agent is not working: what is left is said as its row says it.
  if (input.outboxRetry) {
    return 'retry'
  }
  return input.outboxSending ? 'sending' : null
}

type CommandOutcome = Omit<StructuredAgentSessionCommandOutcome, 'handled'>

/** Which of what a refused command waits on the chat shows right now. */
export type StructuredConversationCommandCauses = Readonly<
  Record<StructuredAgentSessionCommandRefusalCause, boolean>
>

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
  /** What the chat showed at the press. A refusal names its cause only when the chat showed it,
   *  so a host ahead of the chat can't make the line go the moment it lands; else it is said as
   *  any other failure. */
  causes: StructuredConversationCommandCauses
  /** What the chat's loaded start-failure rows state, read when the reply lands. */
  startFailures: () => readonly AgentSessionFailureFact[]
  send: (
    command: AgentSessionConversationCommand
  ) => Promise<StructuredAgentSessionWriteOutcome<AgentSessionConversationCommandResult>>
}): Promise<CommandOutcome> {
  const refused = (
    error: string | null,
    cause: StructuredAgentSessionCommandRefusalCause | undefined
  ): CommandOutcome => ({
    accepted: false,
    error,
    ...(error && cause && input.causes[cause] ? { refusedWhile: cause } : {})
  })
  // A command on its way is the agent's work in flight.
  if (input.pending.current) {
    return { accepted: false, error: heldCommandText(input.command, 'working') }
  }
  // The message ahead reads as sending, and Send is busy until the host has it; nothing is armed.
  if (input.hold === 'ahead') {
    return { accepted: false, error: null }
  }
  if (input.hold !== null) {
    // Each hold here is named for the cause it waits on.
    return refused(heldCommandText(input.command, input.hold), input.hold)
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
    if (value.state === 'completed' && !error) {
      return { accepted: true, error: null }
    }
    return refused(error, structuredAgentSessionCommandHostRefusalCause(value))
  } finally {
    input.pending.current = false
  }
}

/** The composer's /clear or /compact, with what this pane knows about work in flight; and which
 *  of what a refusal waits on the chat shows, which its line stands on. */
export function structuredConversationCommandRunner(args: {
  agentName: string
  pending: { current: boolean }
  /** The host holds a /compact as a card, and this client renders the queue. */
  commandsWait: boolean
  /** What the chat shows: a turn, the Working rule, its background work, its sends. */
  chat: {
    turnId: string | null
    isWorking: boolean
    backgroundTasks: { isMonitoring: boolean; show: boolean }
    submissions: readonly AgentJournalSubmission[]
  }
  /** The chat's pending prompts: a card would wait forever on ones this build cannot answer. */
  prompts: readonly StructuredPromptItem[]
  /** A rewind this pane started is on its way; read at the press. */
  rewindInFlight: { readonly current: boolean }
  outbox: readonly StructuredAgentSessionOutboxEntry[]
  /** The loaded rows, read when the reply lands, for the start failures they state. */
  items: () => readonly AgentJournalRenderItem[]
  write: StructuredAgentSessionWrite
}): {
  run: (command: AgentSessionConversationCommand) => Promise<CommandOutcome>
  causes: StructuredConversationCommandCauses
} {
  const promptPending = args.prompts.length > 0
  const agentWorking = args.chat.turnId !== null || args.chat.isWorking
  const rows = outboxRows(args.outbox, args.chat.submissions, args.agentName)
  const outboxUnsent = hasUnsentStructuredAgentSessionOutboxEntry(
    args.outbox,
    args.chat.submissions
  )
  const causes: StructuredConversationCommandCauses = {
    working: agentWorking,
    prompt: promptPending,
    // The strip, mid-turn included: what a host refusing on background tasks points at.
    background: args.chat.backgroundTasks.show || args.chat.backgroundTasks.isMonitoring,
    // Apart: a send that fails stops being sent, and a resend stops offering Retry.
    sending: rows.outboxSending || outboxUnsent,
    retry: rows.outboxRetry
  }
  const run = (command: AgentSessionConversationCommand) => {
    const waitsInLine =
      command === 'compact' &&
      args.commandsWait &&
      !(promptPending && pendingPromptsAllUnanswerableHere(args.prompts))
    return sendStructuredConversationCommand({
      command,
      agentName: args.agentName,
      pending: args.pending,
      hold: structuredConversationCommandHold({
        waitsInLine,
        agentWorking,
        promptPending,
        // A rewind on its way holds a command as background work does, in the same words.
        backgroundTasksRunning:
          args.chat.backgroundTasks.isMonitoring || args.rewindInFlight.current,
        ...rows,
        outboxUnsent
      }),
      causes,
      startFailures: () => structuredAgentSessionStartFailureFacts(args.items()),
      send: (command) =>
        args.write<AgentSessionConversationCommandResult>(
          'agentSession.conversationCommand',
          'agentSession.conversationCommand',
          command === 'compact' && args.commandsWait
            ? { command, delivery: 'queue-if-active' }
            : { command }
        )
    })
  }
  return { run, causes }
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
