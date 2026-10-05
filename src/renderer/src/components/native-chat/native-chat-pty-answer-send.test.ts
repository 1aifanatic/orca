import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ write: vi.fn(), verified: vi.fn() }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: io.write,
  sendRuntimePtyInputVerified: io.verified
}))
import { formatAsyncQuestionReply } from '../../../../shared/native-chat-async-questions'
import { sendNativeChatMessageWithOutcome } from './native-chat-pty-answer-send'
import { resetNativeChatPtySendQueuesForTests } from './native-chat-runtime-send'
import { buildNativeChatPasteBytes, NATIVE_CHAT_SUBMIT } from './native-chat-send'

beforeEach(() => {
  vi.useFakeTimers()
  resetNativeChatPtySendQueuesForTests()
  io.write.mockReset().mockReturnValue(true)
  io.verified.mockReset().mockResolvedValue(true)
})
afterEach(() => {
  resetNativeChatPtySendQueuesForTests()
  vi.useRealTimers()
})

it('settles accepted once the body and Enter were both accepted', async () => {
  const { outcome } = sendNativeChatMessageWithOutcome(null, 'codex-pane', 'answer')
  await vi.advanceTimersByTimeAsync(1000)
  await expect(outcome).resolves.toBe('accepted')
})

it('settles rejected when the host refuses the write (Codex included)', async () => {
  io.verified.mockResolvedValueOnce(false)
  const { outcome } = sendNativeChatMessageWithOutcome(null, 'codex-pane', 'answer')
  await vi.advanceTimersByTimeAsync(1000)
  await expect(outcome).resolves.toBe('rejected')
  expect(io.verified.mock.calls.map((call) => call[2])).not.toContain(NATIVE_CHAT_SUBMIT)
})

it('settles unknown when the acknowledgement was lost', async () => {
  io.verified.mockRejectedValueOnce(new Error('lost'))
  const { outcome } = sendNativeChatMessageWithOutcome(null, 'codex-pane', 'answer')
  await vi.advanceTimersByTimeAsync(120_000)
  await expect(outcome).resolves.toBe('unknown')
})

it('settles rejected when cancelled before Enter', async () => {
  const { handle, outcome } = sendNativeChatMessageWithOutcome(null, 'codex-pane', 'answer')
  handle.cancel()
  await vi.advanceTimersByTimeAsync(1000)
  await expect(outcome).resolves.toBe('rejected')
})

it('delivers a slash-titled answer as an ordinary pasted message, never a typed command', async () => {
  const text = formatAsyncQuestionReply([{ title: '/model', answer: 'gpt-5' }])
  const { outcome } = sendNativeChatMessageWithOutcome(null, 'codex-pane', text)
  await vi.advanceTimersByTimeAsync(1000)
  await expect(outcome).resolves.toBe('accepted')
  expect(io.verified.mock.calls.map((call) => call[2])).toEqual([
    buildNativeChatPasteBytes('Question: /model\nAnswer: gpt-5'),
    NATIVE_CHAT_SUBMIT
  ])
})
