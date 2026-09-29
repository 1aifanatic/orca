// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { NativeChatDeliveryStatus } from '../../../src/shared/native-chat-pending-delivery'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { retireLandedMobileNativeChatPending } from './mobile-native-chat-pending-retirement'

const roots = new Set<ReturnType<typeof createRoot>>()
function cleanup() {
  for (const root of roots) {
    act(() => root.unmount())
  }
  roots.clear()
}
function renderHook<T, P>(hook: (props: P) => T, options: { initialProps: P }) {
  let props = options.initialProps
  let current: T | undefined
  const root = createRoot(document.createElement('div'))
  roots.add(root)
  function Harness() {
    current = hook(props)
    return null
  }
  const render = () => act(() => root.render(createElement(Harness)))
  render()
  return {
    result: {
      get current(): T {
        if (current === undefined) {
          throw new Error('Hook did not render')
        }
        return current
      }
    },
    rerender(next: P) {
      props = next
      render()
    }
  }
}

const boundary: NativeChatMessage = {
  id: 'boundary',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'before' }],
  timestamp: null,
  source: 'transcript'
}
const working: NativeChatDeliveryStatus = { state: 'working', stateStartedAt: 1 }
const idle: NativeChatDeliveryStatus = { state: 'done', stateStartedAt: 2 }
const idleBefore: NativeChatDeliveryStatus = { state: 'done', stateStartedAt: 0 }
const base = {
  hostId: 'host',
  worktreeId: 'folder',
  tabId: 'tab',
  sessionId: 'session',
  messages: [boundary],
  transcriptSettled: true
}
const readTranscript = vi.fn<() => Promise<NativeChatMessage[] | null>>()
beforeEach(() => {
  vi.useFakeTimers()
  readTranscript.mockReset()
  readTranscript.mockResolvedValue([boundary])
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

it('keeps a send made during a busy turn pending, with no check, after that turn ends', async () => {
  const { result, rerender } = renderHook(
    ({ status }) =>
      useMobileNativeChatDrafts({ ...base, deliveryTracking: { status, readTranscript } }),
    { initialProps: { status: working } }
  )
  act(() => {
    const origin = result.current.captureSendOrigin('follow up')!
    result.current.acceptSend(origin, 'follow up')
  })
  rerender({ status: idle })
  await tick(120_000)
  expect(readTranscript).not.toHaveBeenCalled()
  expect(result.current.pending[0]?.delivery).toBeUndefined()
})

it('checks a send into an idle agent after its turn ends and provides a dismissible notice', async () => {
  const { result, rerender } = renderHook(
    ({ status }) =>
      useMobileNativeChatDrafts({ ...base, deliveryTracking: { status, readTranscript } }),
    { initialProps: { status: idleBefore } }
  )
  act(() => {
    const origin = result.current.captureSendOrigin('follow up')!
    result.current.acceptSend(origin, 'follow up')
  })
  rerender({ status: working })
  await tick(120_000)
  expect(readTranscript).not.toHaveBeenCalled()
  const pendingBefore = result.current.pending
  rerender({ status: working })
  expect(result.current.pending).toBe(pendingBefore)
  rerender({ status: idle })
  await tick(0)
  expect(readTranscript).toHaveBeenCalledOnce()
  expect(result.current.pending[0]?.delivery).toBe('unconfirmed')
  expect(result.current.pending[0]?.text).toBe('follow up')
  act(() => result.current.pending[0]?.onDismiss?.())
  expect(result.current.pending).toEqual([])
})

it('uses the same lifecycle for a lost write acknowledgment and permits a late transcript match', async () => {
  const { result, rerender } = renderHook(
    ({ status, messages }) =>
      useMobileNativeChatDrafts({
        ...base,
        messages,
        deliveryTracking: { status, readTranscript }
      }),
    { initialProps: { status: idleBefore, messages: [boundary] } }
  )
  const report = vi.fn()
  act(() =>
    result.current.holdUnconfirmedSend(
      result.current.captureSendOrigin('one\ntwo')!,
      'one\ntwo',
      report
    )
  )
  rerender({ status: working, messages: [boundary] })
  await tick(120_000)
  expect(report).not.toHaveBeenCalled()
  expect(result.current.pending).toHaveLength(1)
  rerender({ status: idle, messages: [boundary] })
  await tick(0)
  expect(result.current.pending[0]?.delivery).toBe('unconfirmed')
  const echo: NativeChatMessage = {
    ...boundary,
    id: 'user',
    role: 'user',
    blocks: [{ type: 'text', text: '<pasted_content id="a">\none\ntwo\n</pasted_content id="a">' }]
  }
  rerender({ status: idle, messages: [boundary, echo] })
  expect(result.current.pending).toEqual([])
})

it('matches old-host wrapped rows and preserves the second identical send', () => {
  const text = 'one\ntwo'
  const echo: NativeChatMessage = {
    ...boundary,
    id: 'user',
    role: 'user',
    blocks: [{ type: 'text', text: `<pasted_content id="a">\n${text}\n</pasted_content id="a">` }]
  }
  const entry = {
    id: 'one',
    text,
    expectedOccurrence: 1,
    baselineTailMessageId: 'boundary',
    baselineResolved: true
  }
  expect(
    retireLandedMobileNativeChatPending(
      [boundary, echo],
      [entry, { ...entry, id: 'two', expectedOccurrence: 2 }],
      new Set()
    ).map((item) => item.id)
  ).toEqual(['two'])
})

it('does not change structured sends that omit terminal delivery tracking', async () => {
  const { result } = renderHook(() => useMobileNativeChatDrafts(base), { initialProps: undefined })
  const report = vi.fn()
  act(() =>
    result.current.holdUnconfirmedSend(
      result.current.captureSendOrigin('structured')!,
      'structured',
      report
    )
  )
  await tick(20_000)
  expect(report).toHaveBeenCalledOnce()
  expect(result.current.pending).toEqual([])
})
