import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session-journal-types'
import { promptHoldingComposerSlot } from './native-chat-composer-slot'

const PENDING = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const

const QUESTION: { body: AgentJournalItemBody } = {
  body: { kind: 'question', question: 'Which branch?', options: [], resolution: PENDING }
}
const APPROVAL: { body: AgentJournalItemBody } = {
  body: { kind: 'approval', title: 'Run it?', detail: null, options: [], resolution: PENDING }
}
// A subject kind a newer Orca wrote: this build's types cannot name it, so it arrives as JSON does.
const NEWER_APPROVAL: { body: AgentJournalItemBody } = JSON.parse(
  '{"body":{"kind":"approval","title":"Review change","detail":null,"subject":{"kind":"diff","path":"a.ts"},"options":[],"resolution":{"state":"pending","selectedOptionId":null,"resolvedBy":null,"resolvedAt":null}}}'
)

describe('promptHoldingComposerSlot', () => {
  it('leaves the composer shown with no prompt', () => {
    expect(promptHoldingComposerSlot([])).toBeNull()
  })

  it('names the first prompt this build can answer, which stands in the composer slot', () => {
    expect(promptHoldingComposerSlot([QUESTION])).toBe('question')
    expect(promptHoldingComposerSlot([APPROVAL, QUESTION])).toBe('approval')
  })

  it('leaves the composer shown when no prompt can be answered here', () => {
    expect(promptHoldingComposerSlot([NEWER_APPROVAL])).toBeNull()
  })

  it('holds the slot once any prompt can be answered here', () => {
    expect(promptHoldingComposerSlot([NEWER_APPROVAL, QUESTION])).not.toBeNull()
  })
})
