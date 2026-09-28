// A Codex stream error it is about to retry reads as one warning that updates in place, not a
// red row per attempt: the transcript shows how the reconnect is going, once.
import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

const THREAD_ID = 'thread-abc'
const TURN_ID = 'turn-1'

type Row = { key: string; body: AgentJournalItemBody }

function harness() {
  const rows: Row[] = []
  let publishes = 0
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity: AgentJournalItemIdentity, body) =>
      rows.push({ key: agentJournalItemKey(identity), body }),
    appendTombstone: () => undefined,
    publish: () => {
      publishes += 1
    }
  }
  const translator = createCodexJournalTranslator({ sink, primaryThreadId: () => THREAD_ID })
  return { translator, rows, publishes: () => publishes }
}

/** Latest body per identity, in first-seen order: what the journal reducer keeps. */
function reduced(rows: readonly Row[]): Row[] {
  const latest = new Map<string, Row>()
  for (const row of rows) {
    latest.set(row.key, row)
  }
  return [...latest.values()]
}

function notification(method: string, params: unknown): CodexStructuredSessionEvent {
  return { type: 'notification', sessionId: 'session-1', threadId: THREAD_ID, method, params }
}

/** The frame the app server sends for a stream error it is about to retry. */
function retrying(message: string, httpStatusCode: number | null = 502) {
  return notification('error', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    willRetry: true,
    error: {
      message,
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode } },
      additionalDetails: 'stream disconnected before completion'
    }
  })
}

function retryRows(rows: readonly Row[]): Row[] {
  return reduced(rows).filter(
    (row) => row.body.kind === 'status' && row.body.failure?.kind === 'providerRetrying'
  )
}

describe('a Codex stream error it is about to retry', () => {
  it('is one warning row per retry run, revised by every attempt', () => {
    const { translator, rows } = harness()
    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      translator.handle(retrying(`Reconnecting... ${attempt}/5`))
      // Codex reports the thread not running beside each retry; that journals nothing.
      translator.handle(
        notification('thread/status/changed', { threadId: THREAD_ID, status: { type: 'idle' } })
      )
    }

    const firstRun = retryRows(rows)
    expect(firstRun).toHaveLength(1)
    expect(rows.filter((row) => row.key === firstRun[0]?.key)).toHaveLength(3)
    expect(firstRun[0]?.body).toEqual({
      kind: 'status',
      tone: 'warning',
      text: 'Codex is reconnecting: Reconnecting... 3/5.',
      failure: {
        kind: 'providerRetrying',
        detail: { text: 'Reconnecting... 3/5', audience: 'person' },
        retry: { error: 'responseStreamDisconnected', status: 502 }
      }
    })
    // No per-attempt error row is written beside it.
    expect(
      reduced(rows).filter((row) => row.body.kind === 'status' && row.body.tone === 'error')
    ).toEqual([])

    // Codex made progress: a later run is a new row, below that progress.
    translator.handle(
      notification('item/completed', {
        turnId: TURN_ID,
        item: { type: 'agentMessage', id: 'item-1', text: 'Partial answer' }
      })
    )
    translator.handle(retrying('Reconnecting... 1/5'))
    translator.handle(retrying('Reconnecting... 2/5'))

    const runs = retryRows(rows)
    expect(runs).toHaveLength(2)
    expect(runs[0]?.body).toMatchObject({ text: 'Codex is reconnecting: Reconnecting... 3/5.' })
    expect(runs[1]?.body).toMatchObject({ text: 'Codex is reconnecting: Reconnecting... 2/5.' })
    const order = reduced(rows)
    expect(order.findIndex((row) => row.key === runs[1]?.key)).toBeGreaterThan(
      order.findIndex((row) => JSON.stringify(row.body).includes('Partial answer'))
    )
  })

  it('publishes every attempt, so each one renews the idle clock', () => {
    const { translator, publishes } = harness()
    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))

    const before = publishes()
    translator.handle(retrying('Reconnecting... 1/5'))
    translator.handle(retrying('Reconnecting... 2/5'))
    translator.handle(retrying('Reconnecting... 3/5'))

    expect(publishes() - before).toBe(3)
  })

  it('is still one row when Codex names no attempt count', () => {
    const { translator, rows } = harness()
    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))

    translator.handle(retrying('Reconnecting... waiting for network', null))
    translator.handle(retrying('Reconnecting... waiting for network', null))

    const run = retryRows(rows)
    expect(run).toHaveLength(1)
    expect(run[0]?.body).toMatchObject({
      tone: 'warning',
      text: 'Codex is reconnecting: Reconnecting... waiting for network.',
      failure: { retry: { error: 'responseStreamDisconnected' } }
    })
  })

  it('leaves an error Codex will not retry as the red row that fails the turn', () => {
    const { translator, rows } = harness()
    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
    translator.handle(retrying('Reconnecting... 5/5'))

    translator.handle(
      notification('error', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        willRetry: false,
        error: { message: 'stream disconnected before completion' }
      })
    )

    expect(reduced(rows).map((row) => row.body)).toContainEqual(
      expect.objectContaining({
        kind: 'status',
        tone: 'error',
        text: 'stream disconnected before completion'
      })
    )
    expect(reduced(rows).map((row) => row.body)).toContainEqual(
      expect.objectContaining({ kind: 'turn', state: 'completed', outcome: 'failure' })
    )
    expect(retryRows(rows)).toHaveLength(1)
  })
})
