// @vitest-environment happy-dom

// Resume releases a held queue through its own RPC, over the same fenced write every card action
// uses: offered only while no turn runs and the host holds a card it would send; a refusal or a
// failure is one toast, and Resume stays the way to try again.

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from '../../../../shared/agent-session-wire'

type ResumeParams = { envelope: { clientOperationId: string } }

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: ResumeParams) => Promise<unknown>>(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionQueuedMessages } from './use-structured-agent-session-queued-messages'

const RESUMED = {
  ok: true,
  replayed: false,
  fence: 1,
  cursor: { epoch: 'epoch-1', sequence: 1 },
  value: { resumed: true }
}

function card(
  messageId: string,
  fields: Partial<AgentSessionQueuedMessage> = {}
): AgentSessionQueuedMessage {
  const body = { kind: 'message' as const, role: 'user' as const, blocks: [] }
  return { messageId, position: 1, body, state: 'waiting', ...fields }
}

type ControllerInput = {
  enabled?: boolean
  queuedMessages?: AgentSessionQueuedMessage[]
  queuePause?: AgentSessionQueuePause | null
  isWorking?: boolean
  hasPendingPrompt?: boolean
}

function renderController(initialProps: ControllerInput = {}) {
  const stateRef = { current: { fence: 1 } }
  return renderHook(
    (input: ControllerInput) => {
      const { mutate } = useStructuredAgentSessionMutate({
        sessionId: 'session-1',
        target: { kind: 'local' },
        stateRef
      })
      return useStructuredAgentSessionQueuedMessages({
        enabled: input.enabled ?? true,
        queuedMessages: input.queuedMessages ?? [card('held')],
        queuePause: input.queuePause === undefined ? { reason: 'stopped' } : input.queuePause,
        submissions: [],
        hasPendingPrompt: input.hasPendingPrompt ?? false,
        isWorking: input.isWorking ?? false,
        composerScopeKey: undefined,
        mutate
      })
    },
    { initialProps }
  )
}

/** A press of the composer's Resume, which the controller offers only over a held queue. */
function resume(result: { current: { queueResume: { resume: () => Promise<void> } | undefined } }) {
  const offered = result.current.queueResume
  if (!offered) {
    throw new Error('expected Resume to be offered')
  }
  return offered.resume()
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('whether Resume is offered', () => {
  it.each(['stopped', 'restarted', 'cleared', 'some-newer-reason'])(
    "over a card the host holds ('%s') with no turn running",
    (reason) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a newer host may publish a reason this client's type does not list.
      const queuePause = { reason } as AgentSessionQueuePause
      const { result } = renderController({ queuePause })
      expect(result.current.queueResume).toBeDefined()
    }
  )

  it('not without the queue capability: an older host, or no fence yet while connecting', () => {
    expect(renderController({ enabled: false }).result.current.queueResume).toBeUndefined()
  })

  it('not while a turn runs, nor when nothing is held', () => {
    expect(renderController({ isWorking: true }).result.current.queueResume).toBeUndefined()
    expect(renderController({ queuePause: null }).result.current.queueResume).toBeUndefined()
    expect(renderController({ queuedMessages: [] }).result.current.queueResume).toBeUndefined()
  })

  it('not over cards Resume would not send: held on their own, returned, or behind one', () => {
    const queuedMessages = [
      card('failed', { paused: true, pausedReason: 'send_failed' }),
      card('returned', { position: 2, state: 'returned' }),
      card('behind', { position: 3 })
    ]
    expect(renderController({ queuedMessages }).result.current.queueResume).toBeUndefined()
  })
})

describe('while the queue is about to send its next card', () => {
  it('the cards steer and Resume is not offered: the chat reads as working', () => {
    // `isWorking` counts the queue's coming send, which the host names.
    const { result } = renderController({ isWorking: true })
    expect(result.current.turnRunning).toBe(true)
    expect(result.current.queueResume).toBeUndefined()
  })
})

describe('Resume on a held queue', () => {
  it('calls queuedMessagesResume with only an envelope, and says nothing when it lands', async () => {
    mocks.call.mockResolvedValue(RESUMED)
    const { result } = renderController()
    await act(() => resume(result))
    expect(mocks.call).toHaveBeenCalledTimes(1)
    const [, method, params] = mocks.call.mock.calls[0] ?? []
    expect(method).toBe('agentSession.queuedMessagesResume')
    expect(Object.keys(params ?? {})).toEqual(['envelope'])
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('a second press while one is in flight sends nothing', async () => {
    const answer = Promise.withResolvers<unknown>()
    mocks.call.mockReturnValueOnce(answer.promise)
    const { result } = renderController()
    let pending: Promise<void> = Promise.resolve()
    act(() => {
      pending = resume(result)
    })
    expect(result.current.queueResume?.resuming).toBe(true)
    await act(() => resume(result))
    expect(mocks.call).toHaveBeenCalledTimes(1)
    await act(async () => {
      answer.resolve(RESUMED)
      await pending
    })
    expect(result.current.queueResume?.resuming).toBe(false)
  })

  it('a refused or failed Resume is one toast', async () => {
    mocks.call.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'agent_session_conflict', message: 'The session moved on.' }
    })
    mocks.call.mockRejectedValueOnce(new Error('socket closed'))
    const { result } = renderController()
    await act(() => resume(result))
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    await act(() => resume(result))
    expect(mocks.toastError).toHaveBeenCalledTimes(2)
  })

  it('every press is its own operation: a failed Resume never pins the next one to its id', async () => {
    // Resume names no target, so a replayed id would answer `{ resumed: false }` or repeat the
    // same refusal instead of lifting whatever holds the queue now.
    mocks.call.mockRejectedValueOnce(new Error('socket closed'))
    mocks.call.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown', message: 'Unknown operation.' }
    })
    mocks.call.mockResolvedValueOnce(RESUMED)
    const { result } = renderController()
    for (let press = 0; press < 3; press += 1) {
      await act(() => resume(result))
    }
    const ids = mocks.call.mock.calls.map(([, , params]) => params.envelope.clientOperationId)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
  })
})
