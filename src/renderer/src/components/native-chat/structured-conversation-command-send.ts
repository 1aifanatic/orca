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
import { agentSessionFailureStatedByStartRow } from './structured-agent-session-delivery-notices'
import type { StructuredAgentSessionWriteOutcome } from './use-structured-agent-session-mutate'

/** Why this client does not send the command yet. `ahead`: a message this window sent is not
 *  the host's yet, and the command waits for it quietly; the rest are refused here. */
export type StructuredConversationCommandHold = 'ahead' | 'working' | 'prompt' | 'background'

/** A command that waits in line is held only by a message the host doesn't have yet, which must
 *  stay ahead of it; any other command, by anything the agent still has in flight. */
export function structuredConversationCommandHold(input: {
  /** A /compact the host can hold as a card behind the turn or prompt. */
  waitsInLine: boolean
  turnActive: boolean
  promptPending: boolean
  backgroundTasksRunning: boolean
  /** Any message this window sent that the host has not answered. */
  outboxHeld: boolean
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
  return input.turnActive || input.outboxHeld ? 'working' : null
}

/** The line a command refused here gets: a /clear says what the person sees and can do. */
function heldCommandText(
  command: AgentSessionConversationCommand,
  hold: Exclude<StructuredConversationCommandHold, 'ahead'>
): string {
  if (command === 'clear' && (hold === 'working' || hold === 'prompt')) {
    return agentSessionWriteNoticeText(
      hold === 'prompt' ? ['clearAfterAnswer'] : ['agentStillWorking', 'runClearWhenDone']
    )
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
  /** Resolves once the messages ahead of the command are the host's, whatever became of them;
   *  false when this pane went away first, which sends nothing. */
  untilAheadHandedOver: () => Promise<boolean>
  /** What the chat's loaded start-failure rows state, read when the reply lands. */
  startFailures: () => readonly AgentSessionFailureFact[]
  send: (
    command: AgentSessionConversationCommand
  ) => Promise<StructuredAgentSessionWriteOutcome<AgentSessionConversationCommandResult>>
}): Promise<{ accepted: boolean; error: string | null }> {
  // A repeated press: the command already on its way settles the composer's text.
  if (input.pending.current) {
    return { accepted: false, error: null }
  }
  if (input.hold !== null && input.hold !== 'ahead') {
    return { accepted: false, error: heldCommandText(input.command, input.hold) }
  }
  input.pending.current = true
  try {
    // The text stays in the composer meanwhile, which clears only once the command is accepted.
    if (input.hold === 'ahead' && !(await input.untilAheadHandedOver())) {
      return { accepted: false, error: null }
    }
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
