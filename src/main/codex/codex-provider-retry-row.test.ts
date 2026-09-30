// A Codex stream error it is about to retry is a warning row per attempt, never a red row: the
// journal keeps every attempt, and the transcript draws only the latest of a run.
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
  translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
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
function retrying(message: string, additionalDetails?: string) {
  return notification('error', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    willRetry: true,
    error: {
      message,
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
      ...(additionalDetails !== undefined ? { additionalDetails } : {})
    }
  })
}

function retryRows(rows: readonly Row[]): Row[] {
  return reduced(rows).filter(
    (row) => row.body.kind === 'status' && row.body.failure?.kind === 'providerRetrying'
  )
}

describe('a Codex stream error it is about to retry', () => {
  it('writes its own warning row for every attempt', () => {
    const { translator, rows } = harness()

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      translator.handle(retrying(`Reconnecting... ${attempt}/5`, 'stream disconnected'))
    }

    const written = retryRows(rows)
    expect(written).toHaveLength(3)
    expect(new Set(written.map((row) => row.key)).size).toBe(3)
    expect(written.map((row) => row.body.kind === 'status' && row.body.text)).toEqual([
      'Codex is retrying: Reconnecting... 1/5.\nstream disconnected',
      'Codex is retrying: Reconnecting... 2/5.\nstream disconnected',
      'Codex is retrying: Reconnecting... 3/5.\nstream disconnected'
    ])
    expect(written[2]?.body).toEqual({
      kind: 'status',
      tone: 'warning',
      text: 'Codex is retrying: Reconnecting... 3/5.\nstream disconnected',
      failure: {
        kind: 'providerRetrying',
        detail: { text: 'Reconnecting... 3/5', audience: 'person' },
        retry: { error: 'responseStreamDisconnected', status: 502, cause: 'stream disconnected' }
      },
      providerFrame: {
        provider: 'codex',
        kind: 'notification:error',
        payload: expect.objectContaining({ head: expect.stringContaining('Reconnecting... 3/5') })
      }
    })
    // No row revises another: each attempt was written once.
    expect(rows.filter((row) => written.some((retry) => retry.key === row.key))).toHaveLength(3)
    expect(
      reduced(rows).filter((row) => row.body.kind === 'status' && row.body.tone === 'error')
    ).toEqual([])
  })

  it('is one line when Codex gives no detail, or only repeats its message', () => {
    const { translator, rows } = harness()
    translator.handle(retrying('Reconnecting... 1/5'))
    translator.handle(retrying('Reconnecting... 2/5', 'Reconnecting... 2/5'))

    expect(retryRows(rows).map((row) => row.body.kind === 'status' && row.body.text)).toEqual([
      'Codex is retrying: Reconnecting... 1/5.',
      'Codex is retrying: Reconnecting... 2/5.'
    ])
  })

  it('publishes every attempt, so each one renews the idle clock', () => {
    const { translator, publishes } = harness()

    const before = publishes()
    translator.handle(retrying('Reconnecting... 1/5'))
    translator.handle(retrying('Reconnecting... 2/5'))
    translator.handle(retrying('Reconnecting... 3/5'))

    expect(publishes() - before).toBe(3)
  })

  it('leaves an error Codex will not retry as the red row that fails the turn', () => {
    const { translator, rows } = harness()
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
