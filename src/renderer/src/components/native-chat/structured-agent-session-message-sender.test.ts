import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  proof: vi.fn((): boolean => true),
  handBack: vi.fn((): boolean => true)
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  ensureRuntimeEnvironmentCompatible: vi.fn(async () => undefined),
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
    // Given back, but worded as unconfirmed: the earlier attempt may have landed.
    expect(getStructuredAgentSessionSendNotice(SESSION)).toContain(
      "Orca couldn't confirm your message reached the agent"
    )
    mocks.proof.mockReturnValue(true)
  })

  it('gives back on Stop only what has not gone out', async () => {
    const calls = deferredCalls()
    const a = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'a' })
    const b = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'b' })
    await flush()
    expect(withdrawUnsentStructuredAgentSessionSends(SESSION)).toBe(true)
    expect(await b.outcome).toBe('returned')
    expect(phases()).toEqual(['a:sending'])
    calls[0].resolve(okSubmission(a.clientMessageId, 'accepted'))
    expect(await a.outcome).toBe('recorded')
    expect(mocks.handBack).toHaveBeenCalledTimes(1)
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
