import { describe, expect, it } from 'vitest'
import {
  readAgentJournalItemBody,
  readAgentJournalMessageBody
} from './agent-session-journal-body-admission'
import { unclassifiedOptionalFacts } from './agent-session-journal-optional-facts'
import {
  AgentJournalItemBodySchema,
  AgentJournalMessageBodySchema
} from './agent-session-journal-schemas'

const RESOLUTION = { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
const QUESTION = {
  kind: 'question',
  question: 'Which lane?',
  options: [{ id: 'o-1', label: 'First' }],
  questions: [
    {
      id: 'q-1',
      question: 'Which lane?',
      multiSelect: false,
      options: [{ id: 'o-1', label: 'First' }],
      freeTextQuestionId: 'q-1-other'
    }
  ],
  resolution: RESOLUTION
}
const TURN_STATUS = {
  kind: 'status',
  text: 'Turn started',
  turnLifecycle: { turnId: 't-1', state: 'running', startedAt: 5 }
}

/** Reads a copy, so each case starts from the same body; returns the verdict and what is left. */
function read(body: Record<string, unknown>) {
  const copy = structuredClone(body)
  return { verdict: readAgentJournalItemBody(copy), body: copy }
}

it('gives every optional field a body can hold a policy', () => {
  expect(unclassifiedOptionalFacts(AgentJournalItemBodySchema)).toEqual([])
  expect(unclassifiedOptionalFacts(AgentJournalMessageBodySchema)).toEqual([])
})

describe('a body of a kind this build does not know', () => {
  it('is unreadable and left as it was', () => {
    const body = { kind: 'plan-card', steps: [{ text: 'by a newer build' }] }
    expect(read(body)).toEqual({ verdict: 'unreadable', body })
  })

  it.each([
    ['no kind', { text: 'x' }],
    ['an empty kind', { kind: '' }],
    ['a kind that is not a string', { kind: 7 }]
  ])('is damage with %s', (_name, body) => {
    expect(read(body).verdict).toBe('malformed')
  })

  it.each([null, 'status', [{ kind: 'status' }]])('is damage when the body is %j', (body) => {
    expect(readAgentJournalItemBody(body)).toBe('malformed')
  })
})

describe('an optional fact this build cannot parse', () => {
  it.each([
    ['a negative turn duration', { kind: 'turn', turnId: 't', state: 'done', durationMs: -1 }],
    ['a null turn start', { kind: 'turn', turnId: 't', state: 'done', startedAt: null }],
    ['a failure fact with no kind', { kind: 'status', text: 'Failed', failure: { kind: '' } }],
    [
      'context facts of a later shape',
      { kind: 'turn', turnId: 't', state: 'done', contextUsage: 1 }
    ],
    [
      'a tool call id that is only spaces',
      { kind: 'tool-call', name: 'Read', state: 'done', callId: ' ' }
    ]
  ])('drops %s and keeps the row', (_name, body) => {
    const { verdict, body: left } = read(body)
    expect(verdict).toBe('readable')
    const dropped = Object.keys(body).filter((key) => !(key in left))
    expect(dropped).toHaveLength(1)
    expect(left).toEqual(
      Object.fromEntries(Object.entries(body).filter(([key]) => key !== dropped[0]))
    )
  })

  it('drops a broken annotation nested in a block, an option and a turn lifecycle, and keeps them', () => {
    const message = {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'hi', tone: 5 }]
    }
    expect(read(message)).toEqual({
      verdict: 'readable',
      body: { ...message, blocks: [{ type: 'text', text: 'hi' }] }
    })
    const question = { ...QUESTION, options: [{ id: 'o-1', label: 'First', description: 3 }] }
    expect(read(question)).toEqual({
      verdict: 'readable',
      body: { ...question, options: [{ id: 'o-1', label: 'First' }] }
    })
    const status = {
      ...TURN_STATUS,
      turnLifecycle: { ...TURN_STATUS.turnLifecycle, startedAt: 'x' }
    }
    expect(read(status)).toEqual({
      verdict: 'readable',
      body: { ...status, turnLifecycle: { turnId: 't-1', state: 'running' } }
    })
  })

  it.each([
    ['a question list that is not a list', { ...QUESTION, questions: null }],
    ['a question with no free-text id string', { ...QUESTION, freeTextQuestionId: 4 }],
    ['a turn lifecycle with no turn', { ...TURN_STATUS, turnLifecycle: { state: 'running' } }],
    ['a goal change with no goal', { kind: 'status', text: 'Goal', threadGoal: { state: 'set' } }],
    [
      'a plan approval with no plan',
      {
        kind: 'approval',
        title: 'Approve the plan?',
        detail: null,
        options: [{ id: 'yes', label: 'Yes' }],
        resolution: RESOLUTION,
        subject: { kind: 'plan' }
      }
    ]
  ])('makes the row unreadable, not damaged, for must-understand %s', (_name, body) => {
    expect(read(body)).toEqual({ verdict: 'unreadable', body })
  })
})

describe('a field this build does not know', () => {
  it('is ignored and kept, in a prompt option too', () => {
    const body = { ...QUESTION, options: [{ id: 'o-1', label: 'First', shortcut: 'f' }], next: 1 }
    expect(read(body)).toEqual({ verdict: 'readable', body })
  })
})

describe('a required field that fails', () => {
  it.each([
    ['question options that are not a list', { ...QUESTION, options: null }],
    ['a question without its resolution', { ...QUESTION, resolution: undefined }],
    ['a diff whose patch is broken', { kind: 'diff', path: 'a.ts', patch: { head: 'x' } }],
    ['a turn with no state', { kind: 'turn', turnId: 't' }],
    [
      'a known block missing its text',
      { kind: 'message', role: 'user', blocks: [{ type: 'text' }] }
    ]
  ])('is damage: %s', (_name, body) => {
    expect(read(body).verdict).toBe('malformed')
  })
})

describe("a submission's body", () => {
  it('reads a message, a newer kind as unreadable, and another known kind as damage', () => {
    expect(readAgentJournalMessageBody({ kind: 'message', role: 'user', blocks: [] })).toBe(
      'readable'
    )
    expect(readAgentJournalMessageBody({ kind: 'voice-note', clip: 'x' })).toBe('unreadable')
    expect(readAgentJournalMessageBody({ kind: 'status', text: 'x' })).toBe('malformed')
  })
})
