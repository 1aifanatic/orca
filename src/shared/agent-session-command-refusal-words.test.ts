import { describe, expect, it } from 'vitest'
import { agentSessionFailureSentence } from './agent-session-failure-words'
import { readWholeAgentSessionFailureFact } from './agent-session-failure'

describe('commands whose recorded refusal decides the next step', () => {
  it.each([false, true])('keeps a cleared chat action with retryControl=%s', (retryControl) => {
    expect(
      agentSessionFailureSentence(
        {
          kind: 'commandRefused',
          refusal: {
            code: 'agent_session_operation_invalid',
            details: { reason: 'conversationCleared' }
          }
        },
        'rejection',
        { agentName: 'Codex', retryControl }
      )
    ).toBe(
      "Codex didn't run this command. This conversation has been cleared. Open the current conversation to continue."
    )
  })

  it('does not suggest retrying an unsupported command', () => {
    expect(
      agentSessionFailureSentence(
        {
          kind: 'commandRefused',
          refusal: {
            code: 'structured_agent_session_unsupported',
            details: { reason: 'hostUnsupported' }
          }
        },
        'rejection',
        { agentName: 'Claude' }
      )
    ).toBe("Claude doesn't support this command in this chat.")
  })

  it('keeps the prerequisite when an agent is still responding', () => {
    expect(
      agentSessionFailureSentence(
        {
          kind: 'commandRefused',
          refusal: { code: 'agent_session_operation_invalid', details: { reason: 'turnActive' } }
        },
        'rejection',
        { agentName: 'Codex' }
      )
    ).toBe(
      "Codex didn't run this command. Codex is still responding. Wait for it to finish, or stop it."
    )
  })

  it('does not invent a retry action when an old host recorded no reason', () => {
    expect(
      agentSessionFailureSentence({ kind: 'commandRefused' }, 'rejection', { agentName: 'Codex' })
    ).toBe("Codex didn't run this command.")
  })

  it.each([
    'providerStarting',
    'turnActive',
    'promptPending',
    'optionRejected',
    'goalsUnsupported',
    'providerRejected'
  ] as const)('keeps the known agent name in every reused cause/action for %s', (reason) => {
    const text = agentSessionFailureSentence(
      {
        kind: 'commandRefused',
        refusal: {
          code: 'agent_session_operation_invalid',
          details: { reason }
        }
      },
      'rejection',
      { agentName: 'Claude' }
    )
    expect(text).toContain('Claude')
    expect(text).not.toMatch(/the agent/i)
  })

  it('retains a positive no-running-turn verdict when reading a stored Stop fact', () => {
    const fact = { kind: 'stopRefused', turnNotRunning: true } as const
    expect(readWholeAgentSessionFailureFact(fact)).toEqual(fact)
    expect(agentSessionFailureSentence(fact, 'row', { agentName: 'Codex' })).toBe(
      'Codex had no response in progress to stop.'
    )
    expect(
      agentSessionFailureSentence({ kind: 'stopRefused' }, 'row', { agentName: 'Codex' })
    ).toBe("Codex didn't stop. Check the chat before trying again.")
  })
})
