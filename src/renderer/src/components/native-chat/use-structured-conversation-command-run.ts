// What a /clear or /compact from the composer does here: refused while the agent works, or, for a
// /compact the host holds in line, sent at once behind whatever this window has not sent yet.

import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../../shared/agent-session-conversation-command'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { hasUnsentStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox-stop-withdrawal'
import {
  sendStructuredConversationCommand,
  structuredConversationCommandHold
} from './structured-conversation-command-send'
import type { StructuredAgentSessionWriteOutcome } from './use-structured-agent-session-mutate'
import { useStructuredConversationCommandHold } from './use-structured-conversation-command-hold'

export function useStructuredConversationCommandRun(args: {
  agentName: string
  pending: { current: boolean }
  /** The host holds a /compact as a card, and this client renders the queue. */
  commandsWait: boolean
  turnActive: boolean
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
  const untilAheadHandedOver = useStructuredConversationCommandHold(args.outbox, args.submissions)
  return (command) => {
    const waitsInLine =
      command === 'compact' &&
      args.commandsWait &&
      !(args.promptPending && args.promptsUnanswerableHere)
    return sendStructuredConversationCommand({
      command,
      agentName: args.agentName,
      pending: args.pending,
      hold: structuredConversationCommandHold({
        waitsInLine,
        turnActive: args.turnActive,
        promptPending: args.promptPending,
        backgroundTasksRunning: args.backgroundTasksRunning,
        outboxHeld: args.outbox.length > 0,
        outboxUnsent: hasUnsentStructuredAgentSessionOutboxEntry(args.outbox, args.submissions)
      }),
      untilAheadHandedOver,
      startFailures: args.startFailures,
      send: (command) =>
        args.write(
          command === 'compact' && args.commandsWait
            ? { command, delivery: 'queue-if-active' }
            : { command }
        )
    })
  }
}
