// Every way a Codex reasoning row opens and ends.
import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CodexJournalItems } from './codex-structured-journal-items'
import { MAX_CODEX_ACTIVE_ITEMS } from './codex-structured-journal-limits'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-abc'
const TURN_ID = 'turn-1'
const ROW = 'orca:codex-item%3Athread-abc%3Ar-1'

function recorder() {
  const rows = new Map<string, AgentJournalItemBody>()
  /** The host time each row's first write asked to be stamped with. */
  const firstObservedAt = new Map<string, number | undefined>()
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body, options) => {
      const key = agentJournalItemKey(identity)
      if (!rows.has(key)) {
        firstObservedAt.set(key, options.observedAt)
      }
      rows.set(key, body)
    },
    appendTombstone: () => {},
    publish: () => {}
  }
  return { rows, sink, firstObservedAt }
}

function notification(
  method: string,
  params: unknown,
  observedAt?: number
): CodexStructuredSessionEvent {
  return {
    type: 'notification',
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    method,
    params,
    ...(observedAt === undefined ? {} : { observedAt })
  }
}

function reasoning(id: string, summary: string[] = []) {
  return { item: { type: 'reasoning', id, summary, content: [] } }
}

function streamingTurn() {
  const { rows, sink, firstObservedAt } = recorder()
  const translator = createCodexJournalTranslator({
    sink,
    primaryThreadId: () => THREAD_ID,
    sessionId: SESSION_ID,
    // Deltas are written as they arrive, so the open row is visible without a timer.
    schedule: (run) => {
      run()
      return () => {}
    }
  })
  translator.handle(notification('turn/started', { turn: { id: TURN_ID } }, 1_000))
  translator.handle(notification('item/started', reasoning('r-1'), 2_000))
  translator.handle(
    notification('item/reasoning/summaryTextDelta', { itemId: 'r-1', delta: 'Planning' }, 3_000)
  )
  return { rows, translator, firstObservedAt }
}

describe('a Codex reasoning row', () => {
  it('writes no row while its item has no text, and opens with its first summary text', () => {
    const { rows, sink } = recorder()
    const translator = createCodexJournalTranslator({ sink, primaryThreadId: () => THREAD_ID })
    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }, 1_000))
    translator.handle(notification('item/started', reasoning('r-1'), 2_000))
    expect(rows.get(ROW)).toBeUndefined()
    const streamed = streamingTurn()
    expect(streamed.rows.get(ROW)).toMatchObject({ state: 'running' })
  })

  it('starts when its item started, though its first text came later', () => {
    const { firstObservedAt } = streamingTurn()
    expect(firstObservedAt.get(ROW)).toBe(2_000)
  })

  it('ends when its item completes, at the completion it saw', () => {
    const { rows, translator } = streamingTurn()
    translator.handle(notification('item/completed', reasoning('r-1', ['Planning']), 5_000))
    expect(rows.get(ROW)).toEqual({
      kind: 'message',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'Planning' }],
      state: 'completed',
      completedAt: 5_000
    })
  })

  it('ends with its turn when the item never completes', () => {
    const { rows, translator } = streamingTurn()
    translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }, 6_000))
    expect(rows.get(ROW)).toMatchObject({ state: 'completed', completedAt: 6_000 })
  })

  it('ends when the provider exits mid-item', () => {
    const { rows, translator } = streamingTurn()
    translator.handle({ type: 'ended', sessionId: SESSION_ID, reason: 'exit', observedAt: 7_000 })
    expect(rows.get(ROW)).toMatchObject({ state: 'completed', completedAt: 7_000 })
  })

  it('replays from history as ended, with no span it never saw', () => {
    const { rows, sink } = recorder()
    const items = new CodexJournalItems(
      { sink, attributionFor: () => ({ turnScope: AGENT_JOURNAL_THREAD_SCOPE }) },
      () => TURN_ID,
      () => {}
    )
    items.handle(
      { threadId: THREAD_ID, method: 'item/completed', params: reasoning('r-1', ['Planned']) },
      'history'
    )
    expect(rows.get(ROW)).toMatchObject({ state: 'completed' })
    expect(rows.get(ROW)).not.toHaveProperty('completedAt')
  })

  it('ends with no claimed time when it is evicted from the bounded live set', () => {
    const { rows, sink } = recorder()
    const items = new CodexJournalItems(
      { sink, attributionFor: () => ({ turnScope: AGENT_JOURNAL_THREAD_SCOPE }) },
      () => TURN_ID,
      () => {}
    )
    for (let index = 1; index <= MAX_CODEX_ACTIVE_ITEMS + 1; index += 1) {
      items.handle({
        threadId: THREAD_ID,
        method: 'item/started',
        params: reasoning(`r-${index}`, ['Thinking'])
      })
    }
    expect(rows.get(ROW)).toMatchObject({ state: 'completed' })
    expect(rows.get(ROW)).not.toHaveProperty('completedAt')
    expect(rows.get('orca:codex-item%3Athread-abc%3Ar-2')).toMatchObject({ state: 'running' })
  })
})
