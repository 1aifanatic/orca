// @vitest-environment happy-dom

// The queued-message controller: which RPC each card action issues, the
// write-ahead Stop/Edit withdrawal restore (text back in the composer exactly
// once, replays included), and the mount-time recovery of a marker whose
// answer never reached the restore.

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'
import {
  beginQueuedWithdrawal,
  clearQueuedWithdrawalsForTests,
  completeQueuedWithdrawal,
  pendingQueuedWithdrawals
} from './structured-agent-session-queued-restore'
import { useStructuredAgentSessionQueuedMessages } from './use-structured-agent-session-queued-messages'
import type {
  StructuredAgentSessionMutate,
  StructuredAgentSessionWrite
} from './use-structured-agent-session-mutate'

type WriteCall = [string, string, Record<string, unknown>, (string | null | undefined)?]

function body(text: string): AgentSessionQueuedMessage['body'] {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function draft(id: string, position: number): AgentSessionQueuedMessage {
  return { messageId: id, position, body: body(`text of ${id}`), state: 'waiting' }
}

const SCOPE = 'tab-1:pane-scope'

function createHarness(
  overrides: {
    queuedMessages?: AgentSessionQueuedMessage[]
    enabled?: boolean
    writeResult?: (call: WriteCall) => unknown
  } = {}
) {
  const mutate = vi.fn(async () => null)
  const writeCalls: WriteCall[] = []
  const write = vi.fn(async (...call: WriteCall) => {
    writeCalls.push(call)
    return overrides.writeResult ? overrides.writeResult(call) : { kind: 'dropped' }
  })
  const rendered = renderHook(() =>
    useStructuredAgentSessionQueuedMessages({
      sessionId: 'session-1',
      enabled: overrides.enabled ?? true,
      queuedMessages: overrides.queuedMessages ?? [draft('draft-1', 1), draft('draft-2', 2)],
      submissions: [],
      hasPendingPrompt: false,
      composerScopeKey: SCOPE,
      composerScopeKeyForSession: (sessionId) => `tab-1:${sessionId}`,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub answers every mutate with null, a valid outcome for any T.
      mutate: mutate as StructuredAgentSessionMutate,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each scripted answer is the outcome shape of the one write it responds to; generic erasure cannot express that.
      write: write as StructuredAgentSessionWrite
    })
  )
  return { ...rendered, mutate, write, writeCalls }
}

beforeEach(() => {
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  clearQueuedWithdrawalsForTests()
})

afterEach(() => {
  clearQueuedWithdrawalsForTests()
  vi.clearAllMocks()
})

describe('queued message actions', () => {
  it('Steer sends the named draft through queuedMessageSend', async () => {
    const harness = createHarness()
    await act(() => harness.result.current.steer('draft-1'))
    expect(harness.mutate).toHaveBeenCalledWith(
      'agentSession.queuedMessageSend',
      'agentSession.queuedMessageSend',
      { messageId: 'draft-1' }
    )
  })

  it('Cmd/Ctrl+Enter steers the newest card and reports when there is none', async () => {
    const harness = createHarness()
    expect(harness.result.current.steerNewest()).toBe(true)
    await waitFor(() =>
      expect(harness.mutate).toHaveBeenCalledWith(
        'agentSession.queuedMessageSend',
        'agentSession.queuedMessageSend',
        { messageId: 'draft-2' }
      )
    )
    const empty = createHarness({ queuedMessages: [] })
    expect(empty.result.current.steerNewest()).toBe(false)
    const disabled = createHarness({ enabled: false })
    expect(disabled.result.current.steerNewest()).toBe(false)
  })

  it('Delete withdraws through queuedMessageDelete without touching the composer', async () => {
    const harness = createHarness()
    await act(() => harness.result.current.remove('draft-1'))
    expect(harness.mutate).toHaveBeenCalledWith(
      'agentSession.queuedMessageDelete',
      'agentSession.queuedMessageDelete',
      { messageId: 'draft-1' }
    )
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
  })

  it('Edit persists the operation before the RPC and puts the withdrawn text in the composer', async () => {
    let observedPendingAtCallTime = 0
    const harness = createHarness({
      writeResult: (call) => {
        observedPendingAtCallTime = pendingQueuedWithdrawals('session-1').length
        return {
          kind: 'done',
          value: { deleted: true, messageId: call[2].messageId, body: body('edit me') }
        }
      }
    })
    await act(() => harness.result.current.edit('draft-1'))
    expect(observedPendingAtCallTime).toBe(1)
    expect(harness.writeCalls[0]?.[0]).toBe('agentSession.queuedMessageDelete')
    expect(typeof harness.writeCalls[0]?.[3]).toBe('string')
    expect(readNativeChatDraftCache(SCOPE)).toBe('edit me')
    // Restored and settled: the marker is spent.
    expect(pendingQueuedWithdrawals('session-1')).toHaveLength(0)
  })

  it('Stop withdraws drafts and restores every body once, replays included', async () => {
    let operationId = ''
    const harness = createHarness({
      writeResult: (call) => {
        operationId = call[3] ?? ''
        return {
          kind: 'done',
          value: {
            cancelled: true,
            withdrawnQueued: [
              { messageId: 'draft-1', body: body('first draft') },
              { messageId: 'draft-2', body: body('second draft') }
            ]
          }
        }
      }
    })
    await act(() => harness.result.current.stopWithdrawing().then(() => {}))
    expect(harness.writeCalls[0]?.slice(0, 3)).toEqual([
      'agentSession.cancel',
      'agentSession.cancel',
      { withdrawQueued: true }
    ])
    expect(readNativeChatDraftCache(SCOPE)).toBe('first draft\n\nsecond draft')
    // A replayed answer for the same operation restores nothing twice.
    completeQueuedWithdrawal(
      'session-1',
      operationId,
      [{ messageId: 'draft-1', body: body('first draft') }],
      SCOPE
    )
    expect(readNativeChatDraftCache(SCOPE)).toBe('first draft\n\nsecond draft')
  })

  it("Stop never re-appends text the sender's own outbox withdrawal already put back", async () => {
    const harness = createHarness({
      writeResult: () => ({
        kind: 'done',
        value: {
          cancelled: true,
          withdrawnQueued: [
            { messageId: 'draft-1', body: body('already restored locally') },
            { messageId: 'draft-2', body: body('host-held text') }
          ]
        }
      })
    })
    await act(() => harness.result.current.stopWithdrawing(['draft-1']).then(() => {}))
    expect(readNativeChatDraftCache(SCOPE)).toBe('host-held text')
  })

  it('a Stop or clear marker from before a crash NEVER re-runs the command on remount', async () => {
    // Crash-before-reach: the presses were persisted, the RPCs never arrived.
    beginQueuedWithdrawal('session-1', {
      operationId: 'operation-stop-lost',
      kind: 'stop',
      beganAt: Date.now()
    })
    beginQueuedWithdrawal('session-1', {
      operationId: 'operation-clear-lost',
      kind: 'clear',
      beganAt: Date.now()
    })
    const harness = createHarness({ queuedMessages: [draft('draft-1', 1)] })
    // Released, not replayed: reopening a chat must not stop new work or clear it.
    await waitFor(() => expect(pendingQueuedWithdrawals('session-1')).toHaveLength(0))
    expect(harness.write).not.toHaveBeenCalled()
    expect(harness.mutate).not.toHaveBeenCalled()
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
    // The host still holds the drafts; they stay visible as cards.
    expect(harness.result.current.cards.map((card) => card.messageId)).toEqual(['draft-1'])
  })

  it('a crash after the restore completed appends nothing twice on remount', async () => {
    // The Stop applied, its answer arrived, and the restore committed before the crash.
    completeQueuedWithdrawal(
      'session-1',
      'operation-applied',
      [{ messageId: 'draft-1', body: body('restored text') }],
      SCOPE
    )
    expect(readNativeChatDraftCache(SCOPE)).toBe('restored text')
    const harness = createHarness({ queuedMessages: [] })
    await waitFor(() => expect(pendingQueuedWithdrawals('session-1')).toHaveLength(0))
    expect(harness.write).not.toHaveBeenCalled()
    // Restored exactly once: remount adds nothing, and a duplicated answer for the
    // same operation is answered from the durable restored record.
    completeQueuedWithdrawal(
      'session-1',
      'operation-applied',
      [{ messageId: 'draft-1', body: body('restored text') }],
      SCOPE
    )
    expect(readNativeChatDraftCache(SCOPE)).toBe('restored text')
  })

  it('leaves markers for a capability-less mount alone (they expire, nothing runs)', async () => {
    beginQueuedWithdrawal('session-1', {
      operationId: 'operation-waiting',
      kind: 'stop',
      beganAt: Date.now()
    })
    const harness = createHarness({ queuedMessages: [], enabled: false })
    await Promise.resolve()
    expect(harness.write).not.toHaveBeenCalled()
    expect(pendingQueuedWithdrawals('session-1')).toHaveLength(1)
  })

  it("a /clear's answer restores into the replacement session's pane", () => {
    const harness = createHarness()
    let operationId: string | null = null
    act(() => {
      operationId = harness.result.current.beginClearWithdrawal()
    })
    expect(operationId).not.toBeNull()
    expect(pendingQueuedWithdrawals('session-1')).toHaveLength(1)
    act(() =>
      harness.result.current.settleClearWithdrawal(operationId ?? '', {
        command: 'clear',
        state: 'completed',
        replacementSessionId: 'session-2abcdef',
        withdrawnQueued: [{ messageId: 'draft-1', body: body('cleared text') }]
      })
    )
    expect(readNativeChatDraftCache('tab-1:session-2abcdef')).toBe('cleared text')
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
    expect(pendingQueuedWithdrawals('session-1')).toHaveLength(0)
  })
})
