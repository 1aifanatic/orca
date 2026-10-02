import { describe, expect, it } from 'vitest'
import {
  isNativeChatReasoningUnderway,
  nativeChatReasoningOpen,
  nativeChatReasoningHeadline,
  nativeChatReasoningHeadlineText
} from './native-chat-reasoning-row'

describe('the live reasoning gate', () => {
  const open = { turnId: 'turn-1', text: '', reasoning: { session: true, subagents: ['task-1'] } }

  it("answers per scope: the session's own agent, or one subagent by its id", () => {
    expect(nativeChatReasoningOpen(open, 'turn-1')).toBe(true)
    expect(nativeChatReasoningOpen(open, 'turn-1', 'task-1')).toBe(true)
    expect(nativeChatReasoningOpen(open, 'turn-1', 'task-2')).toBe(false)
    const childOnly = { ...open, reasoning: { session: false, subagents: ['task-1'] } }
    expect(nativeChatReasoningOpen(childOnly, 'turn-1')).toBe(false)
  })

  it('reports nothing for another turn, no live turn, or a host that sends no signal', () => {
    expect(nativeChatReasoningOpen(open, 'turn-2')).toBe(false)
    expect(nativeChatReasoningOpen(open, null)).toBe(false)
    expect(nativeChatReasoningOpen({ turnId: 'turn-1', text: 'Running a command' }, 'turn-1')).toBe(
      false
    )
    expect(nativeChatReasoningOpen(null, 'turn-1')).toBe(false)
  })
})

describe('the reasoning row every client draws', () => {
  it('is hidden only while its block is still being written and the host reports it open', () => {
    expect(isNativeChatReasoningUnderway({ role: 'reasoning', state: 'running' }, true)).toBe(true)
    expect(isNativeChatReasoningUnderway({ role: 'reasoning', state: 'running' }, false)).toBe(
      false
    )
    expect(isNativeChatReasoningUnderway({ role: 'reasoning', state: 'completed' }, true)).toBe(
      false
    )
    expect(isNativeChatReasoningUnderway({ role: 'reasoning' }, true)).toBe(false)
    expect(isNativeChatReasoningUnderway({ role: 'assistant', state: 'running' }, true)).toBe(false)
  })

  it('reads the span the host saw, at least a second, and claims none it did not see', () => {
    const text = (fields: { state?: 'running' | 'completed'; completedAt?: number }) =>
      nativeChatReasoningHeadlineText(nativeChatReasoningHeadline({ timestamp: 1_000, ...fields }))
    expect(text({ state: 'completed', completedAt: 66_000 })).toBe('Thought for 1m 5s')
    expect(text({ state: 'completed', completedAt: 1_300 })).toBe('Thought for 1s')
    expect(text({ state: 'completed' })).toBe('Thought')
    expect(text({ state: 'running' })).toBe('Thought')
    expect(text({})).toBe('Reasoning')
  })
})
