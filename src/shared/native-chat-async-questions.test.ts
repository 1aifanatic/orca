import { describe, expect, it } from 'vitest'
import type {
  AgentJournalDispatchState,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { deriveJournalAsyncQuestions } from './native-chat-async-question-facts'
import {
  createNativeChatAsyncQuestionFoldState,
  foldNativeChatAsyncQuestionFact,
  formatAsyncQuestionReply,
  nativeChatAsyncQuestionsAllowHeuristics,
  nativeChatAsyncQuestionsFromFold,
  publishNativeChatAsyncQuestions,
  readNativeChatAsyncQuestionsField,
  type NativeChatAsyncQuestion,
  type NativeChatAsyncQuestionFact
} from './native-chat-async-questions'

function fold(facts: NativeChatAsyncQuestionFact[]): NativeChatAsyncQuestion[] {
  const state = createNativeChatAsyncQuestionFoldState()
  for (const fact of facts) {
    foldNativeChatAsyncQuestionFact(state, fact)
  }
  return nativeChatAsyncQuestionsFromFold(state)
}

const asked = (
  itemId: string,
  titles: string[],
  asker: 'root' | 'child' = 'root'
): NativeChatAsyncQuestionFact => ({
  kind: 'asked',
  asker,
  itemId,
  recordId: `record:${itemId}`,
  questions: titles.map((title) => ({ title }))
})

let sequence = 0
function item(
  itemId: string,
  role: 'user' | 'assistant',
  extra: Partial<AgentJournalRenderItem> & { questions?: string[] } = {}
): AgentJournalRenderItem {
  sequence += 1
  const { questions, ...rest } = extra
  return {
    itemId,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'message',
      role,
      blocks: [
        {
          type: 'text',
          text: itemId,
          ...(questions
            ? {
                asyncQuestions: {
                  providerItemId: `raw-${itemId}`,
                  questions: questions.map((title) => ({ title }))
                }
              }
            : {})
        }
      ]
    },
    ...rest
  }
}

function submission(
  clientMessageId: string,
  state: AgentJournalDispatchState
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'f',
    dispatchState: state,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  }
}

describe('foldNativeChatAsyncQuestionFact', () => {
  it('accumulates root questions, title-only included, under stable keys', () => {
    const questions = fold([asked('a', ['One?', 'Two?']), asked('b', ['Three?'])])
    expect(questions.map((question) => question.key)).toEqual([
      JSON.stringify(['request_user_input_async', 'a', 0]),
      JSON.stringify(['request_user_input_async', 'a', 1]),
      JSON.stringify(['request_user_input_async', 'b', 0])
    ])
  })

  it('retires on a delivered root user message only', () => {
    expect(
      fold([asked('a', ['One?']), { kind: 'delivered-user-message', author: 'root' }])
    ).toEqual([])
    expect(
      fold([asked('a', ['One?']), { kind: 'delivered-user-message', author: 'child' }])
    ).toHaveLength(1)
    expect(fold([asked('a', ['One?']), { kind: 'other' }])).toHaveLength(1)
  })

  it('never collects a child question', () => {
    expect(fold([asked('a', ['Child?'], 'child')])).toEqual([])
  })

  it('keeps every question (no count cap)', () => {
    const titles = Array.from({ length: 20 }, (_, index) => `Q${index}?`)
    expect(fold([asked('a', titles)])).toHaveLength(20)
  })
})

describe('deriveJournalAsyncQuestions', () => {
  it('keys structured questions by the canonical journal item id', () => {
    const items = [item('u1', 'user'), item('a1', 'assistant', { questions: ['Color?'] })]
    expect(deriveJournalAsyncQuestions(items, [])).toEqual([
      {
        key: JSON.stringify(['request_user_input_async', 'a1', 0]),
        providerItemId: 'raw-a1',
        index: 0,
        title: 'Color?'
      }
    ])
  })

  it('retires only on an accepted (or provider-recorded) root user message', () => {
    const ask = item('a1', 'assistant', { questions: ['Color?'] })
    for (const state of ['pending', 'rejected', 'unknown'] as const) {
      const send = item(agentJournalSubmissionKey(`m-${state}`), 'user')
      expect(
        deriveJournalAsyncQuestions([ask, send], [submission(`m-${state}`, state)])
      ).toHaveLength(1)
    }
    const accepted = item(agentJournalSubmissionKey('m-ok'), 'user')
    expect(deriveJournalAsyncQuestions([ask, accepted], [submission('m-ok', 'accepted')])).toEqual(
      []
    )
    expect(deriveJournalAsyncQuestions([ask, item('provider-user', 'user')], [])).toEqual([])
  })

  it('keeps a question past a queued (not yet handed over) message', () => {
    const ask = item('a1', 'assistant', { questions: ['Color?'] })
    const queued = item(agentJournalSubmissionKey('q'), 'user')
    const pending = { ...submission('q', 'pending'), handoverRecorded: true as const }
    expect(deriveJournalAsyncQuestions([ask, queued], [pending])).toHaveLength(1)
  })

  it('keeps a question asked after a steer that is accepted later', () => {
    const steer = item(agentJournalSubmissionKey('s'), 'user')
    const ask = item('a1', 'assistant', { questions: ['Color?'] })
    expect(deriveJournalAsyncQuestions([steer, ask], [submission('s', 'accepted')])).toHaveLength(1)
  })

  it('skips persisted metadata this build cannot read instead of failing the derivation', () => {
    const unreadable = item('a0', 'assistant')
    const block = unreadable.body.kind === 'message' ? unreadable.body.blocks[0] : undefined
    if (block?.type === 'text') {
      Object.assign(block, { asyncQuestions: { questions: [{ title: 'x', options: [{}] }] } })
    }
    const ask = item('a1', 'assistant', { questions: ['Color?'] })
    expect(deriveJournalAsyncQuestions([unreadable, ask], []).map((q) => q.title)).toEqual([
      'Color?'
    ])
  })

  it('ignores child questions and child user messages', () => {
    const ask = item('a1', 'assistant', { questions: ['Root?'] })
    const childUser = item('c-user', 'user', { agentId: 'child-1' })
    const childAsk = item('c-ask', 'assistant', { agentId: 'child-1', questions: ['Child?'] })
    expect(
      deriveJournalAsyncQuestions([ask, childUser, childAsk], []).map((question) => question.title)
    ).toEqual(['Root?'])
  })
})

describe('publication and the client view', () => {
  const question = (index: number, bytes: number): NativeChatAsyncQuestion => ({
    key: `k${index}`,
    index: 0,
    title: 't'.repeat(bytes)
  })

  it('publishes everything that fits', () => {
    expect(publishNativeChatAsyncQuestions([question(1, 10)])).toEqual({
      state: 'ready',
      questions: [question(1, 10)]
    })
  })

  it('publishes the oldest questions within the budget and counts the rest', () => {
    const questions = Array.from({ length: 600 }, (_, index) => question(index, 500))
    const field = publishNativeChatAsyncQuestions(questions)
    expect(field.state).toBe('ready')
    if (field.state !== 'ready') {
      return
    }
    expect(new TextEncoder().encode(JSON.stringify(field)).length).toBeLessThanOrEqual(256 * 1024)
    expect(field.questions[0]?.key).toBe('k0')
    expect(field.questions.length + (field.omittedCount ?? 0)).toBe(600)
    expect(field.omittedCount).toBeGreaterThan(0)
  })

  it('allows heuristics only for an old host or a known-empty set', () => {
    expect(nativeChatAsyncQuestionsAllowHeuristics({ state: 'absent' })).toBe(true)
    expect(nativeChatAsyncQuestionsAllowHeuristics({ state: 'ready', questions: [] })).toBe(true)
    expect(nativeChatAsyncQuestionsAllowHeuristics({ state: 'pending' })).toBe(false)
    expect(
      nativeChatAsyncQuestionsAllowHeuristics({ state: 'ready', questions: [question(1, 1)] })
    ).toBe(false)
  })

  it('reads a wire field defensively', () => {
    expect(readNativeChatAsyncQuestionsField(undefined)).toBeUndefined()
    expect(readNativeChatAsyncQuestionsField({ state: 'pending' })).toEqual({ state: 'pending' })
    expect(
      readNativeChatAsyncQuestionsField({
        state: 'ready',
        questions: [{ key: 'k', index: 0, title: 'T', options: ['A', 2] }, { bad: true }],
        omittedCount: 2
      })
    ).toEqual({
      state: 'ready',
      questions: [{ key: 'k', index: 0, title: 'T', options: ['A'] }],
      omittedCount: 2
    })
    expect(readNativeChatAsyncQuestionsField({ state: 'future' })).toBeUndefined()
  })
})

describe('formatAsyncQuestionReply', () => {
  it('starts every group with a prose prefix, so a slash title is never a command', () => {
    expect(
      formatAsyncQuestionReply([
        { title: '/model', answer: 'gpt-5' },
        { title: 'Why?', answer: 'Because' }
      ])
    ).toBe('Question: /model\nAnswer: gpt-5\n\nQuestion: Why?\nAnswer: Because')
  })
})
