import { describe, expect, it } from 'vitest'
import {
  nativeChatReasoningDisclosureKey,
  nativeChatReasoningHeadline,
  nativeChatReasoningHeadlineText,
  selectNativeChatLiveReasoning
} from './native-chat-reasoning-row'
import type { NativeChatMessage } from './native-chat-types'

function row(
  id: string,
  role: NativeChatMessage['role'],
  text: string,
  fields: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: 1_000,
    source: 'transcript',
    ...fields
  }
}

const prompt = row('user-1', 'user', 'Start the task')
const open = row('r-1', 'reasoning', 'Weighing two approaches', { state: 'running' })
const inTurn = (): boolean => true

describe('the open block the live line discloses', () => {
  it('is the newest root reasoning row with text, while the line reads "Thinking"', () => {
    expect(selectNativeChatLiveReasoning([prompt, open], inTurn, true)).toBe(open)
    // A host that keeps no lifecycle gets the same single live slot.
    const stateless = row('r-1', 'reasoning', 'Weighing two approaches')
    expect(selectNativeChatLiveReasoning([prompt, stateless], inTurn, true)).toBe(stateless)
  })

  it('is nothing unless the line shows "Thinking", or when the block is blank or ended', () => {
    expect(selectNativeChatLiveReasoning([prompt, open], inTurn, false)).toBeNull()
    const blank = row('r-1', 'reasoning', ' \n', { state: 'running' })
    expect(selectNativeChatLiveReasoning([prompt, blank], inTurn, true)).toBeNull()
    const ended = { ...open, state: 'completed' as const }
    expect(selectNativeChatLiveReasoning([prompt, ended], inTurn, true)).toBeNull()
  })

  it('is nothing once a tool or the answer is newer than the block', () => {
    const answer = row('a-1', 'assistant', 'Here it is')
    expect(selectNativeChatLiveReasoning([prompt, open, answer], inTurn, true)).toBeNull()
    const tool = row('t-1', 'assistant', '', {
      blocks: [{ type: 'tool-call', name: 'Read', input: { file_path: 'a.ts' }, state: 'running' }]
    })
    expect(selectNativeChatLiveReasoning([prompt, open, tool], inTurn, true)).toBeNull()
  })

  it('looks past notices, empty rows and rows outside the live working turn', () => {
    const notice = row('s-1', 'system', 'Compacting')
    const empty = row('a-0', 'assistant', '')
    const waiting = row('user-2', 'user', 'Also say banana')
    const live = (index: number): boolean => index < 4
    expect(selectNativeChatLiveReasoning([prompt, open, notice, empty, waiting], live, true)).toBe(
      open
    )
  })

  it('stops at the live turn prompt and ignores a subagent reasoning', () => {
    expect(selectNativeChatLiveReasoning([open, prompt], inTurn, true)).toBeNull()
    const child = row('r-2', 'reasoning', 'Child thinking', { state: 'running', agentId: 'sub-1' })
    expect(selectNativeChatLiveReasoning([prompt, child], inTurn, true)).toBeNull()
    expect(selectNativeChatLiveReasoning([prompt, open, child], inTurn, true)).toBe(open)
  })

  it('keys one block the same for the line and the row, apart from tool runs', () => {
    expect(nativeChatReasoningDisclosureKey('r-1')).toBe('reasoning:r-1')
  })
})

describe('the reasoning headline', () => {
  const text = (
    fields: { state?: 'running' | 'completed'; completedAt?: number },
    live = false
  ): string =>
    nativeChatReasoningHeadlineText(
      nativeChatReasoningHeadline({ timestamp: 1_000, ...fields }, { live })
    )

  it('reads the span the host saw, at least a second, and claims none it did not see', () => {
    expect(text({ state: 'completed', completedAt: 66_000 })).toBe('Thought for 1m 5s')
    expect(text({ state: 'completed', completedAt: 1_300 })).toBe('Thought for 1s')
    expect(text({ state: 'completed' })).toBe('Thought')
    expect(text({ state: 'running' })).toBe('Thought')
    expect(text({})).toBe('Reasoning')
  })

  it('claims no past tense for a block not yet ended inside its working turn', () => {
    expect(text({ state: 'running' }, true)).toBe('Reasoning')
    expect(text({}, true)).toBe('Reasoning')
    expect(text({ state: 'completed', completedAt: 13_000 }, true)).toBe('Thought for 12s')
  })
})
