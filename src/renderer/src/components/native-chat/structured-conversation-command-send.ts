import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../../shared/agent-session-conversation-command'
import { readWholeAgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureSentence } from '../../../../shared/agent-session-failure-words'
import { translate } from '@/i18n/i18n'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import type { StructuredAgentSessionWriteOutcome } from './use-structured-agent-session-mutate'

export async function sendStructuredConversationCommand(input: {
  command: AgentSessionConversationCommand
  /** The chat's agent, as a failed command names it. */
  agentName: string
  pending: { current: boolean }
  blocked: boolean
  send: (
    command: AgentSessionConversationCommand
  ) => Promise<StructuredAgentSessionWriteOutcome<AgentSessionConversationCommandResult>>
}): Promise<{ accepted: boolean; error: string | null }> {
  if (input.pending.current || input.blocked) {
    return {
      accepted: false,
      error: translate(
        'components.native-chat.conversationCommand.pendingWork',
        'Wait for pending work and messages to finish before using this command.'
      )
    }
  }
  input.pending.current = true
  try {
    const outcome = await input.send(input.command)
    if (outcome.kind === 'not-done') {
      return { accepted: false, error: outcome.notice }
    }
    const result = outcome.kind === 'done' ? outcome.value : null
    const error = result
      ? conversationCommandFailureText(result, input.agentName)
      : translate(
          'components.native-chat.conversationCommand.unconfirmed',
          'Conversation operation was not confirmed.'
        )
    return { accepted: result?.state === 'completed' && !error, error }
  } finally {
    input.pending.current = false
  }
}

/** The host's sentence in the reader's language, from the fact beside it; with no fact (an older
 *  host) or one this build can't read whole, the sentence as written. */
function conversationCommandFailureText(
  result: AgentSessionConversationCommandResult,
  agentName: string
): string | null {
  const fact = readWholeAgentSessionFailureFact(result.failure)
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

export function isUnconfirmedConversationCommand(method: string, value: unknown): boolean {
  return (
    method === 'agentSession.conversationCommand' &&
    (value as AgentSessionConversationCommandResult).state === 'unknown'
  )
}
