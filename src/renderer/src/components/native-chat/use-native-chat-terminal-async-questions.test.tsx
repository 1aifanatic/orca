// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeChatAsyncQuestionsView } from '../../../../shared/native-chat-async-questions'
import type * as RuntimeTerminalInspectionModule from '@/runtime/runtime-terminal-inspection'
import type * as NativeChatRuntimeSendModule from './native-chat-runtime-send'

// Only the runtime write is stubbed; the PTY queue, outcome mapping and send lifecycle are real.
const io = vi.hoisted(() => ({ write: vi.fn(), verified: vi.fn() }))
vi.mock('@/runtime/runtime-terminal-inspection', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeTerminalInspectionModule>()),
  sendRuntimePtyInput: io.write,
  sendRuntimePtyInputVerified: io.verified
}))
vi.mock('@/lib/agent-paste-draft', () => ({ getSettingsForAgentTabRuntimeOwner: () => null }))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
vi.mock('./native-chat-runtime-send', async (importOriginal) => ({
  ...(await importOriginal<typeof NativeChatRuntimeSendModule>()),
  sendNativeChatAskAnswer: vi.fn()
}))

const { useNativeChatTerminalAsyncQuestions } =
  await import('./use-native-chat-terminal-async-questions')
const { resetNativeChatPtySendQueuesForTests, sendNativeChatAskAnswer } =
  await import('./native-chat-runtime-send')
const { holdNativeChatPtyForOption } = await import('./native-chat-pty-send-queue')
const { readNativeChatDraftCache, writeNativeChatDraftCache } =
  await import('./native-chat-draft-cache')
const { buildNativeChatPasteBytes, NATIVE_CHAT_SUBMIT } = await import('./native-chat-send')
const { NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT } = await import('./native-chat-input-clear')

// The agent-TUI interrupt key Stop sends; an answer must never write it.
const ESCAPE = '\x1b'

const PANE = 'tab-1:leaf-1'
const view: NativeChatAsyncQuestionsView = {
  state: 'ready',
  questions: [{ key: 'q-a', index: 0, title: 'Which name?', options: ['core', 'base'] }]
}

function mount(overrides: { canSend?: boolean } = {}) {
  const optimistic = {
    record: vi.fn((_text: string): string | undefined => 'pending-1'),
    reject: vi.fn(),
    holdUnconfirmed: vi.fn(),
    cancel: vi.fn()
  }
  const hook = renderHook(() =>
    useNativeChatTerminalAsyncQuestions({
      paneKey: PANE,
      sessionId: 'session-1',
      agent: 'codex',
      terminalTabId: 'tab-1',
      targetPtyId: 'codex-pty',
      canSend: overrides.canSend ?? true,
      view,
      recordOptimistic: optimistic.record,
      optimisticOutcome: optimistic
    })
  )
  act(() => hook.result.current.model.edit('q-a', { option: 'core' }))
  return { hook, optimistic }
}

function writtenBytes(): unknown[] {
  return [...io.write.mock.calls, ...io.verified.mock.calls].map((call) => call[2])
}

beforeEach(() => {
  vi.useFakeTimers()
  resetNativeChatPtySendQueuesForTests()
  io.write.mockReset().mockReturnValue(true)
  io.verified.mockReset().mockResolvedValue(true)
  vi.mocked(sendNativeChatAskAnswer).mockClear()
  writeNativeChatDraftCache(PANE, 'my unsent draft')
})
afterEach(() => {
  cleanup()
  resetNativeChatPtySendQueuesForTests()
  writeNativeChatDraftCache(PANE, '')
  vi.useRealTimers()
})

it('sends the answer as an ordinary message: echo, paste + Enter, never Escape or the ask seam', async () => {
  const { hook, optimistic } = mount()
  act(() => hook.result.current.model.submit())
  expect(hook.result.current.model.sending).toBe(true)
  await act(() => vi.advanceTimersByTimeAsync(1000))

  expect(optimistic.record).toHaveBeenCalledWith('Question: Which name?\nAnswer: core')
  expect(writtenBytes()).toEqual([
    NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
    buildNativeChatPasteBytes('Question: Which name?\nAnswer: core'),
    NATIVE_CHAT_SUBMIT
  ])
  expect(sendNativeChatAskAnswer).not.toHaveBeenCalled()
  expect(optimistic.reject).not.toHaveBeenCalled()
  expect(optimistic.holdUnconfirmed).not.toHaveBeenCalled()
  // Delivered: edits clear, but the card stays until the host's set drops the question.
  expect(hook.result.current.model.sending).toBe(false)
  expect(hook.result.current.model.edits).toEqual({})
  expect(hook.result.current.model.open.map((question) => question.key)).toEqual(['q-a'])
  expect(readNativeChatDraftCache(PANE)).toBe('my unsent draft')
})

it('marks the echo not sent and keeps the edits when the host refuses the write', async () => {
  io.verified.mockResolvedValueOnce(false)
  const { hook, optimistic } = mount()
  act(() => hook.result.current.model.submit())
  await act(() => vi.advanceTimersByTimeAsync(1000))

  expect(optimistic.reject).toHaveBeenCalledWith('pending-1')
  expect(writtenBytes()).not.toContain(NATIVE_CHAT_SUBMIT)
  expect(hook.result.current.model.edits).toEqual({ 'q-a': { option: 'core' } })
  expect(hook.result.current.model.canSend).toBe(true)
  expect(readNativeChatDraftCache(PANE)).toBe('my unsent draft')
})

it('holds the echo unconfirmed and keeps the edits when the acknowledgement is lost', async () => {
  io.verified.mockRejectedValueOnce(new Error('lost'))
  const { hook, optimistic } = mount()
  act(() => hook.result.current.model.submit())
  await act(() => vi.advanceTimersByTimeAsync(120_000))

  expect(optimistic.holdUnconfirmed).toHaveBeenCalledWith('pending-1')
  expect(optimistic.reject).not.toHaveBeenCalled()
  expect(hook.result.current.model.edits).toEqual({ 'q-a': { option: 'core' } })
  expect(hook.result.current.model.canSend).toBe(true)
})

it('Stop before Enter settles rejected: the echo is withdrawn, edits kept, no Escape written', async () => {
  const { hook, optimistic } = mount()
  act(() => hook.result.current.model.submit())
  await act(() => vi.advanceTimersByTimeAsync(10))
  act(() => hook.result.current.cancelPendingAnswers())
  await act(() => vi.advanceTimersByTimeAsync(1000))

  expect(optimistic.cancel).toHaveBeenCalledWith('pending-1')
  expect(writtenBytes()).not.toContain(NATIVE_CHAT_SUBMIT)
  expect(writtenBytes()).not.toContain(ESCAPE)
  expect(hook.result.current.model.sending).toBe(false)
  expect(hook.result.current.model.edits).toEqual({ 'q-a': { option: 'core' } })
  expect(hook.result.current.model.canSend).toBe(true)
  expect(readNativeChatDraftCache(PANE)).toBe('my unsent draft')
})

it('refuses without an echo or a write while a model switch holds the PTY', async () => {
  const release = holdNativeChatPtyForOption('codex-pty')
  const { hook, optimistic } = mount()
  act(() => hook.result.current.model.submit())
  await act(() => vi.advanceTimersByTimeAsync(1000))
  release()

  expect(optimistic.record).not.toHaveBeenCalled()
  expect(writtenBytes()).toEqual([])
  expect(hook.result.current.model.edits).toEqual({ 'q-a': { option: 'core' } })
  expect(hook.result.current.model.canSend).toBe(true)
})

it('refuses without an echo or a write while another client holds the terminal', async () => {
  const { hook, optimistic } = mount({ canSend: false })
  act(() => hook.result.current.model.submit())
  await act(() => vi.advanceTimersByTimeAsync(1000))

  expect(optimistic.record).not.toHaveBeenCalled()
  expect(writtenBytes()).toEqual([])
  expect(hook.result.current.model.edits).toEqual({ 'q-a': { option: 'core' } })
})
