// The CLI answers an API error (a retired model, a lost sign-in) with a synthetic assistant reply,
// then a failed result repeating its text: captured in the auth-failed lifecycle capture, Claude
// Code 2.1.280. The chat says it once.

import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

const MODEL_ERROR =
  "There's an issue with the selected model (claude-retired-1). It may not exist or you may not have access to it."

function journaled() {
  const items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => items.push({ identity, body }),
    appendTombstone: () => {},
    publish: vi.fn()
  }
  return { items, translator: createClaudeJournalTranslator({ sink }) }
}

function frame(message: Record<string, unknown>, startsTurn = false) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    ...(startsTurn ? { startsTurn: true as const } : {}),
    message: { session_id: 'claude-session', parent_tool_use_id: null, ...message }
  }
}

function sendEcho(text: string) {
  return frame(
    { type: 'user', uuid: 'user-1', message: { role: 'user', content: [{ type: 'text', text }] } },
    true
  )
}

function apiErrorReply(text: string) {
  return frame({
    type: 'assistant',
    uuid: 'assistant-1',
    error: 'model_not_found',
    is_api_error_message: true,
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] }
  })
}

function failedResult(text: string) {
  return frame({
    type: 'result',
    subtype: 'success',
    uuid: 'result-1',
    is_error: true,
    result: text,
    terminal_reason: 'api_error'
  })
}

function statusRows(items: { body: AgentJournalItemBody }[]): string[] {
  return items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : []))
}

describe('a Claude API error the turn already replied with', () => {
  it('is said once, as the reply, and the turn reads failed', () => {
    const { items, translator } = journaled()

    translator.handle(sendEcho('hello'))
    translator.handle(apiErrorReply(MODEL_ERROR))
    translator.handle(failedResult(MODEL_ERROR))

    expect(items.filter((item) => JSON.stringify(item.body).includes('selected model'))).toEqual([
      expect.objectContaining({
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: MODEL_ERROR }] }
      })
    ])
    expect(statusRows(items)).toEqual([])
    expect(items.findLast((item) => item.identity.provider === 'legacy')?.body).toMatchObject({
      kind: 'turn',
      state: 'completed',
      outcome: 'failure'
    })
  })

  it('still gets its error row when the failed result says something the reply did not', () => {
    const { items, translator } = journaled()

    translator.handle(sendEcho('hello'))
    translator.handle(apiErrorReply('Not logged in'))
    translator.handle(failedResult('API Error: 529 upstream overloaded'))

    expect(statusRows(items)).toEqual(['API Error: 529 upstream overloaded'])
  })

  it('does not hide the error row of a later turn', () => {
    const { items, translator } = journaled()

    translator.handle(sendEcho('hello'))
    translator.handle(apiErrorReply(MODEL_ERROR))
    translator.handle(failedResult(MODEL_ERROR))
    translator.handle({
      ...sendEcho('again'),
      message: { ...sendEcho('again').message, uuid: 'user-2' }
    })
    translator.handle({
      ...failedResult(MODEL_ERROR),
      message: { ...failedResult(MODEL_ERROR).message, uuid: 'result-2' }
    })

    expect(statusRows(items)).toEqual([MODEL_ERROR])
  })
})
