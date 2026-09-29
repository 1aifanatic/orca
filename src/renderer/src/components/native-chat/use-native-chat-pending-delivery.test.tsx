// @vitest-environment happy-dom
import { act, renderHook, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { useNativeChatPendingDelivery } from './use-native-chat-pending-delivery'
import { clearPendingSendCacheForTests } from './native-chat-pending'
const mocks = vi.hoisted(() => {
  const state: { status: AgentStatusEntry | undefined; read: ReturnType<typeof vi.fn> } = {
    status: undefined,
    read: vi.fn()
  }
  return state
})
vi.mock('../../store', () => ({
  useAppStore: (
    select: (s: { agentStatusByPaneKey: Record<string, AgentStatusEntry | undefined> }) => unknown
  ) => select({ agentStatusByPaneKey: { pane: mocks.status } })
}))
vi.mock('./native-chat-session-transport', () => ({
  getNativeChatSessionTransport: () => ({ readSession: mocks.read })
}))
const boundary: NativeChatMessage = {
  id: 'boundary',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'before' }],
  timestamp: 1,
  source: 'transcript'
}
const args = {
  paneKey: 'pane',
  agent: 'claude' as const,
  sessionId: 'session',
  runtimeEnvironmentId: null,
  messages: [boundary]
}
function status(state: AgentStatusEntry['state'], epoch: number): AgentStatusEntry {
  return {
    state,
    stateStartedAt: epoch,
    updatedAt: epoch,
    paneKey: 'pane',
    prompt: '',
    stateHistory: []
  }
}
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  clearPendingSendCacheForTests()
  mocks.read.mockReset()
  mocks.read.mockResolvedValue({ messages: [boundary] })
  mocks.status = status('working', 1)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('desktop and paired-web pending delivery', () => {
  it('keeps a send made during a busy turn pending, with no check, after that turn ends', async () => {
    // Claude folds such a send into the running turn as a record the transcript reader drops.
    const { result, rerender } = renderHook(() => useNativeChatPendingDelivery(args))
    act(() => result.current.record('follow up'))
    await tick(120_000)
    mocks.status = status('done', 2)
    rerender()
    await tick(120_000)
    expect(mocks.read).not.toHaveBeenCalled()
    expect(result.current.notices.size).toBe(0)
    expect(result.current.pending[0]?.delivery).toBeUndefined()
  })
  it('checks a send into an idle agent after its turn ends and keeps the text recoverable', async () => {
    mocks.status = status('done', 1)
    const { result, rerender } = renderHook(() => useNativeChatPendingDelivery(args))
    act(() => result.current.record('follow up'))
    mocks.status = status('working', 2)
    rerender()
    await tick(120_000)
    expect(mocks.read).not.toHaveBeenCalled()
    mocks.status = status('done', 3)
    rerender()
    await tick(0)
    expect(mocks.read).toHaveBeenCalledOnce()
    expect(result.current.pending[0]?.text).toBe('follow up')
    expect([...result.current.notices.values()][0]?.text).toMatch(/Delivery unconfirmed/)
    act(() => [...result.current.notices.values()][0]?.onDismiss?.())
    expect(result.current.pending).toEqual([])
  })
  it('flags a send an idle agent never starts a turn for, such as Claude having exited', async () => {
    mocks.status = status('done', 1)
    const { result } = renderHook(() => useNativeChatPendingDelivery(args))
    act(() => result.current.record('lost'))
    await tick(19_000)
    expect(mocks.read).not.toHaveBeenCalled()
    await tick(1_000)
    expect(mocks.read).toHaveBeenCalledOnce()
    expect(result.current.pending[0]?.delivery).toBe('unconfirmed')
  })
  it('uses the fresh read when the status arrives before the transcript stream', async () => {
    mocks.status = status('done', 1)
    const { result, rerender } = renderHook(() => useNativeChatPendingDelivery(args))
    act(() => result.current.record('one\ntwo'))
    mocks.read.mockResolvedValue({
      messages: [
        boundary,
        {
          ...boundary,
          id: 'user',
          role: 'user',
          blocks: [
            { type: 'text', text: '<pasted_content id="a">\none\ntwo\n</pasted_content id="a">' }
          ]
        }
      ]
    })
    mocks.status = status('done', 2)
    rerender()
    await tick(0)
    expect(result.current.pending[0]?.delivery).toBe('confirmed')
    expect(result.current.notices.size).toBe(0)
  })
  it('bounds the no-status case across a remount and retires a late echo', async () => {
    mocks.status = undefined
    const first = renderHook(() => useNativeChatPendingDelivery(args))
    act(() => first.result.current.record('later'))
    await tick(10_000)
    first.unmount()
    const next = renderHook(({ messages }) => useNativeChatPendingDelivery({ ...args, messages }), {
      initialProps: { messages: [boundary] }
    })
    await tick(10_000)
    expect(next.result.current.pending[0]?.delivery).toBe('unconfirmed')
    next.rerender({
      messages: [
        boundary,
        { ...boundary, id: 'user', role: 'user', blocks: [{ type: 'text', text: 'later' }] },
        { ...boundary, id: 'answer' }
      ]
    })
    expect(next.result.current.pending).toEqual([])
  })
  it('keeps rejected writes distinct and does not use an unreadable transcript as absence', async () => {
    const { result, rerender } = renderHook(() => useNativeChatPendingDelivery(args))
    act(() => {
      const id = result.current.record('refused')
      result.current.reject(id)
    })
    expect([...result.current.notices.values()][0]?.text).toBe('Message not sent')
    mocks.status = status('done', 1)
    rerender()
    act(() => result.current.record('uncertain'))
    mocks.read.mockResolvedValue({ error: 'disconnected' })
    mocks.status = status('done', 2)
    rerender()
    await tick(0)
    expect(result.current.pending[1]?.delivery).toBeUndefined()
  })
  it('does not let an old source read settle sends after the pane changes', async () => {
    let resolve: ((result: { messages: NativeChatMessage[] }) => void) | undefined
    mocks.read.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const { result, rerender } = renderHook(
      ({ paneKey }) => useNativeChatPendingDelivery({ ...args, paneKey }),
      { initialProps: { paneKey: 'pane' } }
    )
    mocks.status = status('done', 1)
    rerender({ paneKey: 'pane' })
    act(() => result.current.record('old'))
    mocks.status = status('done', 2)
    rerender({ paneKey: 'pane' })
    await tick(0)
    rerender({ paneKey: 'other' })
    await act(async () => resolve?.({ messages: [boundary] }))
    expect(result.current.pending).toEqual([])
  })
})

it('adopts newly available working status instead of spending the no-status deadline', async () => {
  mocks.status = undefined
  const { result, rerender } = renderHook(() => useNativeChatPendingDelivery(args))
  act(() => result.current.record('queued'))
  mocks.status = status('working', 10)
  rerender()
  await tick(120_000)
  expect(result.current.notices.size).toBe(0)
  mocks.status = status('done', 11)
  rerender()
  await tick(0)
  expect(result.current.pending[0]?.delivery).toBe('unconfirmed')
})
it('bounds a missing-status send even when its confirmation read rejects', async () => {
  mocks.status = undefined
  mocks.read.mockRejectedValue(new Error('offline'))
  const { result } = renderHook(() => useNativeChatPendingDelivery(args))
  act(() => result.current.record('recover me'))
  await tick(20_000)
  expect(result.current.pending[0]?.delivery).toBe('unconfirmed')
  expect(result.current.pending[0]?.text).toBe('recover me')
})
it('keeps pending and notices referentially stable across status and stream updates', () => {
  const { result, rerender } = renderHook(
    ({ messages }) => useNativeChatPendingDelivery({ ...args, messages }),
    { initialProps: { messages: [boundary] } }
  )
  act(() => result.current.record('stable'))
  const { pending, notices } = result.current
  mocks.status = status('working', 5)
  rerender({ messages: [boundary, { ...boundary, id: 'streamed' }] })
  expect(result.current.pending).toBe(pending)
  expect(result.current.notices).toBe(notices)
})
