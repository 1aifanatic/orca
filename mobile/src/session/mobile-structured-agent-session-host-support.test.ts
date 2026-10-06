import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
  AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session-stop-capabilities'
import { structuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'

describe('structuredAgentSessionHostSupport', () => {
  it('reads each structured-session feature from the host capability list', () => {
    expect(structuredAgentSessionHostSupport([])).toEqual({
      promptCancel: false,
      questionAnswers: false,
      queuedMessages: false,
      quietRepeatedStop: false,
      conversationStop: false
    })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY])
    ).toEqual({
      promptCancel: false,
      questionAnswers: true,
      queuedMessages: false,
      quietRepeatedStop: false,
      conversationStop: false
    })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY])
    ).toEqual({
      promptCancel: true,
      questionAnswers: false,
      queuedMessages: false,
      quietRepeatedStop: false,
      conversationStop: false
    })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY])
    ).toEqual({
      promptCancel: false,
      questionAnswers: false,
      queuedMessages: true,
      quietRepeatedStop: false,
      conversationStop: false
    })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY])
    ).toEqual({
      promptCancel: false,
      questionAnswers: false,
      queuedMessages: false,
      quietRepeatedStop: true,
      conversationStop: false
    })
  })

  it('reads whether the host takes a Stop naming no turn', () => {
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY])
        .conversationStop
    ).toBe(true)
  })
})
