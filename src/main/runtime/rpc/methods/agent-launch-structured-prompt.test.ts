/**
 * The commit half of launch-prompt delivery: what the host sends, and what it is willing to claim.
 *
 * The assertions that matter are that the send is shaped like every other client's — the entry's
 * operation id IS the client message id, and the fingerprint is computed over the same body — and
 * that no failure mode can return an id, because an id is what the caller reads as "committed".
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { StructuredAgentSessionSendSettlement } from '../../../native-chat/agent-session-wire/structured-agent-session-send-settlement'
import {
  commitStructuredAgentSessionLaunchPrompt,
  deliverStructuredAgentSessionLaunchPrompt,
  STRUCTURED_LAUNCH_PROMPT_SETTLEMENT_BUDGET_MS,
  STRUCTURED_LAUNCH_PROMPT_STILL_STARTING
} from './agent-launch-structured-prompt'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/structured-agent-session-mutation'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-outbox'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'

const CALLER = { callerKey: 'trusted-local:runtime' }

function hostWith(
  send: ReturnType<typeof vi.fn>,
  journalSnapshot: ReturnType<typeof vi.fn> = vi.fn(() => ({ submissions: [] }))
): StructuredAgentSessionHost {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements the only method this module reaches; any other would throw rather than read a wrong value.
  return { send, journalSnapshot } as unknown as StructuredAgentSessionHost
}

function commit(host: StructuredAgentSessionHost | null, text = 'do the thing') {
  return commitStructuredAgentSessionLaunchPrompt({
    host,
    caller: CALLER,
    sessionId: 'sess-1',
    fence: 4,
    text
  })
}

describe('committing a launch prompt', () => {
  it('sends the entry as its own client message id and names the committed row', async () => {
    const send = vi.fn(async (_caller, params) => ({
      ok: true as const,
      value: { clientMessageId: params.envelope.clientOperationId, submission: {} }
    }))

    const messageId = await commit(hostWith(send))

    const [caller, params] = send.mock.calls[0]
    expect(caller).toEqual(CALLER)
    expect(messageId).toBe(params.envelope.clientOperationId)
    expect(params.envelope).toMatchObject({ sessionId: 'sess-1', expectedRuntimeFence: 4 })
    expect(params.body).toEqual(structuredAgentSessionSendBody('do the thing', []))
    // The host recomputes and compares this, so a launch send must fingerprint like a client send.
    expect(params.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: 'sess-1',
        fields: { body: params.body }
      })
    )
  })

  it('claims nothing when the send is refused', async () => {
    const send = vi.fn(async () => ({
      ok: false as const,
      refusal: { code: 'agent_session_operation_invalid', message: 'no' }
    }))
    await expect(commit(hostWith(send))).resolves.toBeNull()
  })

  it('recovers a committed row when settlement throws after append', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let clientMessageId = ''
    const send = vi.fn(
      async (_caller: unknown, params: { envelope: { clientOperationId: string } }) => {
        clientMessageId = params.envelope.clientOperationId
        throw new Error('host gone')
      }
    )
    const journalSnapshot = vi.fn((_sessionId) => ({
      submissions: [{ clientMessageId }]
    }))
    await expect(commit(hostWith(send, journalSnapshot))).resolves.toEqual(clientMessageId)
  })

  it('claims nothing, and does not fail the launch, when no row was committed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const send = vi.fn(async () => {
      throw new Error('host gone')
    })
    await expect(commit(hostWith(send))).resolves.toBeNull()
  })

  it('sends nothing when there is no host or no text', async () => {
    const send = vi.fn()
    await expect(commit(null)).resolves.toBeNull()
    await expect(commit(hostWith(send), '   ')).resolves.toBeNull()
    expect(send).not.toHaveBeenCalled()
  })
})

/** A host whose first message the test moves along, read through the host's own settlement wait. */
function settlingHost() {
  let submission: AgentJournalSubmission | undefined
  const journal = {
    submissions: () => (submission ? [submission] : []),
    cursor: () => ({ epoch: 'epoch-1', sequence: 2 }),
    activeTurnId: () => null
  }
  const settlement = new StructuredAgentSessionSendSettlement(() => journal)
  const send = vi.fn(
    async (_caller: unknown, params: { envelope: { clientOperationId: string } }) => {
      submission = {
        clientMessageId: params.envelope.clientOperationId,
        fence: 4,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'pending',
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null,
        handoverRecorded: true
      }
      return {
        ok: true as const,
        value: { clientMessageId: submission.clientMessageId, submission }
      }
    }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements the only host methods the delivery reaches.
  const host = {
    send,
    journalSnapshot: vi.fn(async () => ({ submissions: journal.submissions() })),
    waitForSendSettlement: settlement.wait
  } as unknown as StructuredAgentSessionHost
  return {
    host,
    /** The host publishing the message's next state, as its journal commits do. */
    becomes: (change: Partial<AgentJournalSubmission>) => {
      submission = { ...submission!, ...change }
      settlement.publish('sess-1', journal)
    }
  }
}

function deliver(host: StructuredAgentSessionHost) {
  return deliverStructuredAgentSessionLaunchPrompt({
    host,
    caller: CALLER,
    sessionId: 'sess-1',
    fence: 4,
    text: 'review my notes'
  })
}

describe('a launch prompt followed to whether its agent took it', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('names the row once the agent takes it', async () => {
    const { host, becomes } = settlingHost()
    const delivered = deliver(host)
    await vi.waitFor(() => expect(host.send).toHaveBeenCalled())
    becomes({ dispatchState: 'accepted', resolvedAt: 2 })

    await expect(delivered).resolves.toMatchObject({ taken: true, messageId: expect.any(String) })
  })

  it("is not taken when the start fails for good, in the host's words", async () => {
    const { host, becomes } = settlingHost()
    const delivered = deliver(host)
    await vi.waitFor(() => expect(host.send).toHaveBeenCalled())
    becomes({
      dispatchState: 'rejected',
      reason: 'Claude is not signed in. Sign in, then send your message again.',
      rejection: { kind: 'notSignedIn' }
    })

    await expect(delivered).resolves.toEqual({
      taken: false,
      warning: 'Claude is not signed in. Sign in, then send your message again.'
    })
  })

  it('waits through a retried start, and at the budget refuses as an unknown outcome, never later', async () => {
    vi.useFakeTimers()
    const { host, becomes } = settlingHost()
    let refused: unknown
    let answered = false
    void deliver(host).then(
      () => {
        answered = true
      },
      (error: unknown) => {
        refused = error
      }
    )
    await vi.advanceTimersByTimeAsync(0)
    becomes({
      startFailure: {
        attempts: 1,
        reason: 'An account switch is in progress.',
        rejection: { kind: 'accountSwitchInProgress' },
        failedAt: 1,
        nextAttemptAt: 15_001
      }
    })

    await vi.advanceTimersByTimeAsync(STRUCTURED_LAUNCH_PROMPT_SETTLEMENT_BUDGET_MS - 1)
    expect(refused).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(answered).toBe(false)
    expect(refused).toMatchObject({
      refusal: {
        code: 'agent_session_operation_unknown',
        message: STRUCTURED_LAUNCH_PROMPT_STILL_STARTING
      }
    })
  })

  it('waits through a lost answer, and names the row once it turns accepted', async () => {
    vi.useFakeTimers()
    const { host, becomes } = settlingHost()
    let answer: unknown
    void deliver(host).then((value) => {
      answer = value
    })
    await vi.advanceTimersByTimeAsync(0)
    becomes({ handedOverAt: 2, dispatchState: 'unknown' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(answer).toBeUndefined()

    becomes({ dispatchState: 'accepted', resolvedAt: 3 })
    await vi.advanceTimersByTimeAsync(0)
    expect(answer).toMatchObject({ taken: true, messageId: expect.any(String) })
  })

  it('refuses as an unknown outcome when the answer is still lost at the budget', async () => {
    vi.useFakeTimers()
    const { host, becomes } = settlingHost()
    let refused: unknown
    let answered = false
    void deliver(host).then(
      () => {
        answered = true
      },
      (error: unknown) => {
        refused = error
      }
    )
    await vi.advanceTimersByTimeAsync(0)
    becomes({ handedOverAt: 2, dispatchState: 'unknown' })

    await vi.advanceTimersByTimeAsync(STRUCTURED_LAUNCH_PROMPT_SETTLEMENT_BUDGET_MS)
    expect(answered).toBe(false)
    expect(refused).toMatchObject({ refusal: { code: 'agent_session_operation_unknown' } })
  })
})
