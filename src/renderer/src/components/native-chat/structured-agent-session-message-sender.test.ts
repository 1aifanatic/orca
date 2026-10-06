import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  proof: vi.fn((): boolean => true),
  compatible: vi.fn(async (): Promise<void> => undefined),
  handBack: vi.fn((): boolean => true)
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  ensureRuntimeEnvironmentCompatible: mocks.compatible,
  runtimeEnvironmentSupportsCapability: vi.fn(async () => mocks.proof())
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () =>
    mocks.proof() ? ['agent-session.send-answers-proof.v1'] : [],
  ensureLocalRuntimeCapabilities: vi.fn(async () => [])
}))
vi.mock('./structured-agent-session-message-hand-back', () => ({
  handBackStructuredAgentSessionMessage: mocks.handBack
}))

import {
  STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS,
  resetStructuredAgentSessionSendsForTests,
  sendStructuredAgentSessionMessage,
  settleStructuredAgentSessionSendsFromJournal,
  withdrawUnsentStructuredAgentSessionSends
} from './structured-agent-session-message-sender'
import {
  getStructuredAgentSessionPendingSends,
  getStructuredAgentSessionSendNotice
} from './structured-agent-session-pending-sends'
import { noteStructuredAgentSessionFence } from './structured-agent-session-send-attempt'

const SESSION = 'session-1'
const target = { kind: 'local' } as const

type Deferred = { resolve: (value: unknown) => void; reject: (error: unknown) => void }

function deferredCalls(): Deferred[] {
  const calls: Deferred[] = []
  mocks.call.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        calls.push({ resolve, reject })
      })
  )
  return calls
}

function submission(
  clientMessageId: string,
  dispatchState: AgentJournalSubmission['dispatchState'],
  extra: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields the sender reads.
  return { clientMessageId, dispatchState, submittedAt: 1, ...extra } as AgentJournalSubmission
}

function okSubmission(clientMessageId: string, dispatchState: 'pending' | 'accepted') {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'e', sequence: 1 },
    value: { clientMessageId, submission: submission(clientMessageId, dispatchState) }
  }
}

const refusedFirst = {
  ok: false,
  refusal: { code: 'agent_session_conflict', message: 'busy', details: { reason: 'chatStarting' } }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
  }
}

function sendCalls(): number {
  return mocks.call.mock.calls.filter((call) => call[1] === 'agentSession.send').length
}

function phases(): string[] {
  return getStructuredAgentSessionPendingSends(SESSION).map(
    (entry) =>
      `${entry.body.blocks[0]?.type === 'text' ? entry.body.blocks[0].text : ''}:${entry.phase}`
  )
}

describe('structured agent session message sender', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.call.mockReset()
    mocks.handBack.mockClear()
    mocks.proof.mockClear()
    mocks.compatible.mockReset()
    mocks.compatible.mockResolvedValue(undefined)
    noteStructuredAgentSessionFence(SESSION, 4)
  })
  afterEach(() => {
    resetStructuredAgentSessionSendsForTests()
    vi.useRealTimers()
  })

  it('sends one at a time, in order, and the host answer settles each', async () => {
    const calls = deferredCalls()
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'b' })
    await flush()
    expect(phases()).toEqual(['a:sending', 'b:waiting'])
    expect(calls).toHaveLength(1)
    calls[0].resolve(okSubmission(a.clientMessageId, 'accepted'))
    await flush()
    expect(await a.outcome).toBe('recorded')
    expect(phases()).toEqual(['b:sending'])
    expect(mocks.call.mock.calls[1][2]).toMatchObject({
      envelope: { sessionId: SESSION, expectedRuntimeFence: 4 },
      body: { blocks: [{ type: 'text', text: 'b' }] }
    })
  })

  it('keeps a pending send only to give back what a Stop withdraws', async () => {
    const calls = deferredCalls()
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    await flush()
    calls[0].resolve(okSubmission(a.clientMessageId, 'pending'))
    await flush()
    expect(phases()).toEqual(['a:recorded'])
    settleStructuredAgentSessionSendsFromJournal(
      SESSION,
      [submission(a.clientMessageId, 'rejected', { rejection: { kind: 'cancelled' } })],
      []
    )
    expect(mocks.handBack).toHaveBeenCalledTimes(1)
    expect(phases()).toEqual([])
  })

  it('never hands back a message the host recorded and then rejected: its row says not sent', async () => {
    const calls = deferredCalls()
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    await flush()
    calls[0].resolve(okSubmission(a.clientMessageId, 'pending'))
    await flush()
    settleStructuredAgentSessionSendsFromJournal(
      SESSION,
      [submission(a.clientMessageId, 'rejected', { rejection: { kind: 'notSignedIn' } })],
      []
    )
    expect(mocks.handBack).not.toHaveBeenCalled()
    expect(phases()).toEqual([])
  })

  it('settles from the journal before the reply, and ignores the late reply', async () => {
    const calls = deferredCalls()
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'b' })
    await flush()
    settleStructuredAgentSessionSendsFromJournal(SESSION, [], [a.clientMessageId])
    expect(await a.outcome).toBe('recorded')
    await flush()
    expect(phases()).toEqual(['b:sending'])
    calls[0].reject(new Error('timeout'))
    await flush()
    expect(phases()).toEqual(['b:sending'])
  })

  it('never probes a host-recorded unknown, and sends what follows it', async () => {
    const calls = deferredCalls()
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'b' })
    await flush()
    // The agent died with the message on its way: the host recorded it and can't tell.
    settleStructuredAgentSessionSendsFromJournal(
      SESSION,
      [submission(a.clientMessageId, 'unknown', { recovered: true })],
      []
    )
    expect(await a.outcome).toBe('recorded')
    await flush()
    expect(phases()).toEqual(['b:sending'])
    expect(calls).toHaveLength(2)
    expect(mocks.handBack).not.toHaveBeenCalled()
  })

  it('gives a refused first attempt back to the composer with the reason', async () => {
    mocks.call.mockResolvedValue(refusedFirst)
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    expect(await a.outcome).toBe('returned')
    expect(mocks.handBack).toHaveBeenCalledTimes(1)
    expect(getStructuredAgentSessionSendNotice(SESSION)).toBeTruthy()
    sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'b' })
    expect(getStructuredAgentSessionSendNotice(SESSION)).toBeNull()
  })

  it('gives back a remote image with the connection it lives on, which never goes to the host', async () => {
    mocks.call.mockResolvedValue(refusedFirst)
    const a = sendStructuredAgentSessionMessage({
      sessionId: SESSION,
      target,
      text: 'look',
      attachments: [{ path: '/remote/shot.png', previewUri: 'x', connectionId: 'ssh-1' }]
    })
    expect(await a.outcome).toBe('returned')
    expect(mocks.handBack).toHaveBeenCalledWith(
      SESSION,
      a.clientMessageId,
      expect.objectContaining({ blocks: expect.any(Array) }),
      ['ssh-1']
    )
    expect(JSON.stringify(mocks.call.mock.calls[0][2])).not.toContain('ssh-1')
  })

  it('resends the same id after a thrown error, then gives it back as unconfirmed at the deadline', async () => {
    mocks.call.mockRejectedValue(new Error('connection closed'))
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.call.mock.calls.length).toBeGreaterThanOrEqual(3)
    for (const call of mocks.call.mock.calls) {
      expect(call[2]).toMatchObject({ envelope: { clientOperationId: a.clientMessageId } })
    }
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
    expect(await a.outcome).toBe('returned')
    expect(phases()).toEqual([])
    expect(mocks.handBack).toHaveBeenCalledTimes(1)
    expect(getStructuredAgentSessionSendNotice(SESSION)).toContain(
      "Orca couldn't confirm your message reached the agent"
    )
    const calls = mocks.call.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.call.mock.calls.length).toBe(calls)
  })

  it('never holds a later send behind one nobody answered', async () => {
    mocks.call.mockRejectedValueOnce(new Error('timeout')).mockRejectedValue(new Error('timeout'))
    sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
    mocks.call.mockReset()
    const calls = deferredCalls()
    sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'b' })
    await flush()
    expect(phases()).toEqual(['b:sending'])
    expect(calls).toHaveLength(1)
  })

  it('gives back a message that never went out by the deadline, without sending it', async () => {
    const hang = new Promise(() => {})
    // Reading the fence hangs (an unreachable host): nothing was ever sent.
    mocks.call.mockImplementation((_target, method: string) =>
      method === 'agentSession.history' ? hang : Promise.resolve(refusedFirst)
    )
    const { resetStructuredAgentSessionSendsForTests: reset } =
      await import('./structured-agent-session-message-sender')
    reset()
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
    expect(await a.outcome).toBe('returned')
    expect(mocks.handBack).toHaveBeenCalledTimes(1)
    expect(mocks.call.mock.calls.some((call) => call[1] === 'agentSession.send')).toBe(false)
  })

  it('reads a refusal of a resent id as proof only from a host that answers with proof', async () => {
    mocks.proof.mockReturnValue(false)
    mocks.call.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(refusedFirst)
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await a.outcome).toBe('returned')
    // Given back, but worded as unconfirmed: the earlier attempt may have landed, so check first.
    expect(getStructuredAgentSessionSendNotice(SESSION)).toContain(
      "Orca couldn't confirm your message reached the agent. Check the chat"
    )
    // Nothing sends it again on its own.
    const calls = mocks.call.mock.calls.length
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS * 2)
    expect(mocks.call.mock.calls.length).toBe(calls)
    mocks.proof.mockReturnValue(true)
  })

  // A Stop, or the chat's tab closing, which withdraws the same way.
  it('gives back on Stop only what has not gone out, and never sends it', async () => {
    const calls = deferredCalls()
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    const b = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'b' })
    const c = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'c' })
    await flush()
    withdrawUnsentStructuredAgentSessionSends(SESSION)
    expect(await b.outcome).toBe('returned')
    expect(await c.outcome).toBe('returned')
    expect(getStructuredAgentSessionSendNotice(SESSION)).toBeNull()
    expect(phases()).toEqual(['a:sending'])
    calls[0].resolve(okSubmission(a.clientMessageId, 'accepted'))
    expect(await a.outcome).toBe('recorded')
    expect(mocks.handBack).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
    expect(sendCalls()).toBe(1)
  })

  it('never resends a send that was on its way when Stop was pressed', async () => {
    mocks.call.mockRejectedValue(new Error('timeout'))
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    await flush()
    // The first attempt went out and its answer was lost: a same-id resend is due.
    withdrawUnsentStructuredAgentSessionSends(SESSION)
    expect(await a.outcome).toBe('returned')
    expect(getStructuredAgentSessionSendNotice(SESSION)).toContain(
      "Orca couldn't confirm your message reached the agent. Check the chat"
    )
    const calls = mocks.call.mock.calls.length
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
    expect(mocks.call.mock.calls.length).toBe(calls)
  })

  it('lets a send on its way when Stop was pressed settle from its answer, never a resend', async () => {
    const calls = deferredCalls()
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    await flush()
    withdrawUnsentStructuredAgentSessionSends(SESSION)
    calls[0].reject(new Error('timeout'))
    expect(await a.outcome).toBe('returned')
    expect(getStructuredAgentSessionSendNotice(SESSION)).toContain(
      "Orca couldn't confirm your message reached the agent. Check the chat"
    )
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
    expect(calls).toHaveLength(1)
  })

  it('never resends after a Stop that lands while the resend is being readied', async () => {
    const remote = { kind: 'environment', environmentId: 'env-1' } as const
    mocks.call.mockRejectedValue(new Error('connection closed'))
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target: remote, text: 'a' })
    await flush()
    expect(sendCalls()).toBe(1)
    // The resend's timer fires; it waits on the host's version check before its request goes out.
    let ready = (): void => {}
    mocks.compatible.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(1_000)
    withdrawUnsentStructuredAgentSessionSends(SESSION)
    ready()
    expect(await a.outcome).toBe('returned')
    expect(getStructuredAgentSessionSendNotice(SESSION)).toContain(
      "Orca couldn't confirm your message reached the agent. Check the chat"
    )
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
    expect(sendCalls()).toBe(1)
  })

  it('settles a send on its way at a Stop from its answer: recorded, or the host held it as a card', async () => {
    const calls = deferredCalls()
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    await flush()
    withdrawUnsentStructuredAgentSessionSends(SESSION)
    // The journal shows its row, whatever the Stop did.
    settleStructuredAgentSessionSendsFromJournal(
      SESSION,
      [submission(a.clientMessageId, 'accepted')],
      []
    )
    expect(await a.outcome).toBe('recorded')
    const b = sendStructuredAgentSessionMessage({
      sessionId: SESSION,
      target,
      text: 'b',
      delivery: 'queue-if-active'
    })
    await flush()
    withdrawUnsentStructuredAgentSessionSends(SESSION)
    calls[1].resolve({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'e', sequence: 1 },
      value: {
        clientMessageId: b.clientMessageId,
        queued: { messageId: b.clientMessageId, position: 0, state: 'waiting' }
      }
    })
    expect(await b.outcome).toBe('recorded')
    expect(mocks.handBack).not.toHaveBeenCalled()
  })

  it("lets a send kept as a card be the card's, from its reply or the journal", async () => {
    const kept = (id: string) =>
      submission(id, 'rejected', {
        rejection: { kind: 'hostRestarted' },
        keptAsQueuedMessageId: id
      })
    mocks.call.mockImplementation(async (_target, _method, params) => ({
      ok: true,
      replayed: true,
      fence: 1,
      cursor: { epoch: 'e', sequence: 1 },
      value: {
        clientMessageId: params.envelope.clientOperationId,
        submission: kept(params.envelope.clientOperationId)
      }
    }))
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    expect(await a.outcome).toBe('recorded')
    const calls = deferredCalls()
    const b = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'b' })
    await flush()
    // Even a kept row whose words read as a Stop's: the card holds the text, never the composer.
    settleStructuredAgentSessionSendsFromJournal(
      SESSION,
      [{ ...kept(b.clientMessageId), rejection: { kind: 'cancelled' } }],
      []
    )
    expect(await b.outcome).toBe('recorded')
    calls[0].reject(new Error('timeout'))
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
    expect(mocks.handBack).not.toHaveBeenCalled()
    expect(sendCalls()).toBe(2)
  })

  it('hands back silently a send whose own reply says a Stop withdrew it', async () => {
    mocks.call.mockImplementation(async (_target, _method, params) => ({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'e', sequence: 1 },
      value: {
        clientMessageId: params.envelope.clientOperationId,
        submission: submission(params.envelope.clientOperationId, 'rejected', {
          rejection: { kind: 'cancelled' }
        })
      }
    }))
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    expect(await a.outcome).toBe('returned')
    expect(mocks.handBack).toHaveBeenCalledTimes(1)
    expect(getStructuredAgentSessionSendNotice(SESSION)).toBeNull()
  })

  it('leaves a send to its own answer while the journal has no row for it', async () => {
    const calls = deferredCalls()
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    await flush()
    settleStructuredAgentSessionSendsFromJournal(SESSION, [submission('other', 'accepted')], [])
    expect(phases()).toEqual(['a:sending'])
    calls[0].resolve(okSubmission(a.clientMessageId, 'accepted'))
    expect(await a.outcome).toBe('recorded')
  })

  it('reads a pending row in the journal as the host holding it, kept only for a Stop', async () => {
    deferredCalls()
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'b' })
    await flush()
    settleStructuredAgentSessionSendsFromJournal(
      SESSION,
      [submission(a.clientMessageId, 'pending')],
      []
    )
    expect(await a.outcome).toBe('recorded')
    await flush()
    expect(phases()).toEqual(['a:recorded', 'b:sending'])
  })

  it('reads a send the host left in doubt at a Stop as its record, and sends the next', async () => {
    deferredCalls()
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'b' })
    await flush()
    settleStructuredAgentSessionSendsFromJournal(
      SESSION,
      [
        submission(a.clientMessageId, 'unknown', {
          recovered: true,
          reason: 'provider_closed_before_acknowledgement'
        })
      ],
      []
    )
    expect(await a.outcome).toBe('recorded')
    await flush()
    expect(phases()).toEqual(['b:sending'])
    expect(mocks.handBack).not.toHaveBeenCalled()
  })

  it('keeps the queue request fixed across resends of one id', async () => {
    mocks.call.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({
      ok: true,
      replayed: true,
      fence: 1,
      cursor: { epoch: 'e', sequence: 1 },
      value: { clientMessageId: 'x', queued: { messageId: 'x', position: 0, state: 'waiting' } }
    })
    const a = sendStructuredAgentSessionMessage({
      sessionId: SESSION,
      target,
      text: 'a',
      delivery: 'queue-if-active'
    })
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await a.outcome).toBe('recorded')
    for (const call of mocks.call.mock.calls) {
      expect(call[2]).toMatchObject({ delivery: 'queue-if-active' })
    }
    expect(phases()).toEqual([])
  })
})

// An earlier build kept a message whose fate was unknown and sent nothing behind it until someone
// decided it, which froze the chat. Nothing here waits on one past its own deadline.
describe('a send whose fate is unknown never freezes the chat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.call.mockReset()
    mocks.handBack.mockClear()
    mocks.proof.mockReturnValue(true)
    mocks.compatible.mockReset()
    mocks.compatible.mockResolvedValue(undefined)
    noteStructuredAgentSessionFence(SESSION, 4)
  })
  afterEach(() => {
    resetStructuredAgentSessionSendsForTests()
    vi.useRealTimers()
  })

  it('holds what was sent behind one nobody answers no longer than its deadline', async () => {
    mocks.call.mockRejectedValue(new Error('connection closed'))
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    const b = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'b' })
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS - 1)
    expect(phases()).toEqual(['a:sending', 'b:waiting'])
    await vi.advanceTimersByTimeAsync(1)
    expect(await a.outcome).toBe('returned')
    expect(await b.outcome).toBe('returned')
    expect(phases()).toEqual([])
    // The next message goes out at once.
    mocks.call.mockReset()
    deferredCalls()
    sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'c' })
    await flush()
    expect(phases()).toEqual(['c:sending'])
    expect(sendCalls()).toBe(1)
  })

  it('sends the next at once when the host can neither confirm nor deny the one ahead', async () => {
    mocks.call.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({
      ok: false,
      refusal: {
        code: 'agent_session_operation_expired',
        message: 'expired',
        details: { reason: 'operationExpired' }
      }
    })
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'b' })
    await flush()
    const calls = deferredCalls()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await a.outcome).toBe('returned')
    expect(getStructuredAgentSessionSendNotice(SESSION)).toContain(
      "Orca couldn't confirm your message reached the agent. Check the chat"
    )
    await flush()
    expect(phases()).toEqual(['b:sending'])
    expect(calls).toHaveLength(1)
  })
})
