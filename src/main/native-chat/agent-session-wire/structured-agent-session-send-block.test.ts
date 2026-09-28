import { describe, expect, it } from 'vitest'
import type { AgentSessionConversationCommandRecord } from '../../../shared/agent-session-conversation-command'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import { structuredAgentSessionSendBlock } from './structured-agent-session-send-preparation'

function withCommand(command: AgentSessionConversationCommandRecord) {
  return { ...agentSessionRecordFixture(), conversationCommand: command }
}

const COMMAND = { operationId: 'operation-1', callerKey: 'client-1', runtimeFence: 7 }

describe('a send refused by the conversation command it follows', () => {
  it('says a /clear that never committed did not finish, not that the chat was cleared', () => {
    const blocked = structuredAgentSessionSendBlock(
      withCommand({
        ...COMMAND,
        command: 'clear',
        state: 'unknown',
        phase: 'prepared',
        replacementSessionId: 'clear-replacement-1'
      })
    )

    expect(blocked?.refusal).toMatchObject({
      code: 'agent_session_operation_invalid',
      details: { reason: 'clearUnconfirmed' },
      message: "The last /clear didn't finish. Start a new chat to continue."
    })
  })

  it('says a committed /clear cleared the conversation', () => {
    const blocked = structuredAgentSessionSendBlock(
      withCommand({
        ...COMMAND,
        command: 'clear',
        state: 'completed',
        phase: 'committed',
        replacementSessionId: 'clear-replacement-1'
      })
    )

    expect(blocked?.refusal).toMatchObject({
      code: 'agent_session_operation_invalid',
      details: { reason: 'conversationCleared' }
    })
  })

  it('keeps an unconfirmed /compact as an unconfirmed command', () => {
    const blocked = structuredAgentSessionSendBlock(
      withCommand({ ...COMMAND, command: 'compact', state: 'unknown', phase: 'prepared' })
    )

    expect(blocked?.refusal).toMatchObject({
      details: { reason: 'conversationCommandUnconfirmed' }
    })
  })

  it('lets a send follow a /clear whose new conversation failed to start', () => {
    expect(
      structuredAgentSessionSendBlock(
        withCommand({ ...COMMAND, command: 'clear', state: 'completed', phase: 'committed' })
      )
    ).toBeNull()
  })
})
