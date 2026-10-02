import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSendResult } from '../../../shared/agent-session-wire'
import { ORCHESTRATION_READINESS_TIMEOUT_MS } from '../../../shared/orchestration-timing-budgets'
import { dispatchPreambleSendOptions } from './preamble'
import {
  sendAgentTurn,
  type StructuredAgentTurnHost,
  type StructuredSessionTurn
} from './send-agent-turn'

function submissionOf(
  dispatchState: AgentJournalSubmission['dispatchState']
): AgentJournalSubmission {
  return {
    clientMessageId: 'op-1',
    fence: 7,
    payloadFingerprint: 'fp',
    providerItemId: null,
    submittedAt: 1,
    resolvedAt: null,
    dispatchState,
    reason: null
  }
}

type HostSendAnswer = Awaited<ReturnType<StructuredAgentTurnHost['send']>>

const accepted = (value: AgentSessionSendResult): HostSendAnswer => ({
  ok: true,
  replayed: false,
  fence: 7,
  cursor: { epoch: 'e', sequence: 1 },
  value
})

function structuredHost(answer: HostSendAnswer, settled?: AgentJournalSubmission | 'throws') {
  const send = vi.fn(async () => answer)
  const waitForSendSettlement = vi.fn(async () => {
    if (settled === 'throws') {
      throw new Error('agent session send disappeared before settlement')
    }
    return settled
      ? {
          cursor: { epoch: 'e', sequence: 2 },
          value: { clientMessageId: 'op-1', submission: settled }
        }
      : undefined
  })
  const host: StructuredAgentTurnHost = { send, waitForSendSettlement }
  return { host, send, waitForSendSettlement }
}

const turn: StructuredSessionTurn = {
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
  delivery: 'now',
  operationId: 'op-1',
  expectedRuntimeFence: 7,
  payloadFingerprint: 'fp'
}

const target = (host: StructuredAgentTurnHost) =>
  ({ kind: 'structured-session', host, sessionId: 's1', callerKey: 'trusted-local:k' }) as const

describe('sendAgentTurn to a structured session', () => {
  it('sends `now` as the composer path with no delivery, so a busy chat is steered as today', async () => {
    const fake = structuredHost(
      accepted({ clientMessageId: 'op-1', submission: submissionOf('accepted') })
    )
    await expect(sendAgentTurn(target(fake.host), turn)).resolves.toEqual({
      kind: 'sent',
      clientMessageId: 'op-1',
      submission: submissionOf('accepted')
    })
    expect(fake.send).toHaveBeenCalledWith(
      { callerKey: 'trusted-local:k' },
      {
        envelope: {
          sessionId: 's1',
          clientOperationId: 'op-1',
          expectedRuntimeFence: 7,
          payloadFingerprint: 'fp'
        },
        body: turn.body
      }
    )
    expect(fake.waitForSendSettlement).not.toHaveBeenCalled()
  })

  it('waits a pending send out through the host settlement waiter', async () => {
    const fake = structuredHost(
      accepted({ clientMessageId: 'op-1', submission: submissionOf('pending') }),
      submissionOf('accepted')
    )
    await expect(sendAgentTurn(target(fake.host), turn)).resolves.toMatchObject({
      kind: 'sent',
      submission: { dispatchState: 'accepted' }
    })
    expect(fake.waitForSendSettlement).toHaveBeenCalledWith('s1', 'op-1', {
      budgetMs: ORCHESTRATION_READINESS_TIMEOUT_MS
    })
  })

  it('keeps the first answer when the wait runs out or fails', async () => {
    for (const settled of [undefined, 'throws'] as const) {
      const fake = structuredHost(
        accepted({ clientMessageId: 'op-1', submission: submissionOf('pending') }),
        settled
      )
      await expect(sendAgentTurn(target(fake.host), turn)).resolves.toMatchObject({
        kind: 'sent',
        submission: { dispatchState: 'pending' }
      })
    }
  })

  it('returns the host refusal for the caller to read', async () => {
    const refusal = { code: 'agent_session_not_attached' as const, message: 'not attached' }
    const fake = structuredHost({ ok: false, refusal })
    await expect(sendAgentTurn(target(fake.host), turn)).resolves.toEqual({
      kind: 'refused',
      refusal
    })
  })

  it('asks the host queue to hold a `queue` send, and reports it queued', async () => {
    const fake = structuredHost(
      accepted({
        clientMessageId: 'op-1',
        queued: { messageId: 'op-1', position: 0, state: 'waiting' }
      })
    )
    await expect(sendAgentTurn(target(fake.host), { ...turn, delivery: 'queue' })).resolves.toEqual(
      { kind: 'queued', clientMessageId: 'op-1' }
    )
    expect(fake.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ delivery: 'queue-if-active' })
    )
    expect(fake.waitForSendSettlement).not.toHaveBeenCalled()
  })
})

describe('sendAgentTurn to a terminal', () => {
  it('types the prompt through the runtime primitive and returns its receipt unchanged', async () => {
    const receipt = { handle: 'term_1', accepted: true, bytesWritten: 5 }
    const runtime = { sendTerminalAgentPrompt: vi.fn(async () => receipt) }
    await expect(
      sendAgentTurn(
        { kind: 'terminal', runtime, handle: 'term_1' },
        { body: 'hello', delivery: 'now', operationId: 'req-1' }
      )
    ).resolves.toBe(receipt)
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term_1',
      'hello',
      dispatchPreambleSendOptions('req-1')
    )
  })

  it('propagates a failed write as the primitive threw it', async () => {
    const failure = new Error('terminal_not_writable')
    const runtime = {
      sendTerminalAgentPrompt: vi.fn(async () => {
        throw failure
      })
    }
    await expect(
      sendAgentTurn(
        { kind: 'terminal', runtime, handle: 'term_1' },
        { body: 'hello', delivery: 'now', operationId: 'req-1' }
      )
    ).rejects.toBe(failure)
  })
})
