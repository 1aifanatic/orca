// Text an agent has streamed stays ahead of a host write issued after it, even inside the window
// that coalesces its deltas: the item takes its place in the journal when its first delta arrives,
// and the window only delays the snapshot of its text. Driven through the real host and journal,
// with the real Claude and Codex translators fed synthetic frames; the provider child is a double.

import { beforeEach, describe, expect, it, type Mock } from 'vitest'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { createClaudeJournalTranslator } from '../../claude/claude-structured-journal-translation'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'

let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>

beforeEach(() => {
  ;({ host, acquire } = hostTestState())
})

const STREAMED = 'Looking at the tests first.'

type Stream = { openTurn: () => void; streamText: (text: string) => void }

/** The coalescing window, closed only when the test says so. */
function heldWindow() {
  const pending: (() => void)[] = []
  return {
    schedule: (run: () => void) => {
      pending.push(run)
      return () => {
        const index = pending.indexOf(run)
        if (index !== -1) {
          pending.splice(index, 1)
        }
      }
    },
    close: () => {
      for (const run of pending.splice(0)) {
        run()
      }
    }
  }
}

function codexStream(sink: StructuredAgentSessionEventSink, schedule: Schedule): Stream {
  const translator = createCodexJournalTranslator({
    sink,
    sessionId: SESSION,
    primaryThreadId: () => THREAD,
    schedule
  })
  const notify = (method: string, params: Record<string, unknown>) =>
    translator.handle({
      type: 'notification',
      sessionId: SESSION,
      threadId: THREAD,
      method,
      params: { threadId: THREAD, turnId: 'turn-1', turn: { id: 'turn-1' }, ...params }
    })
  return {
    openTurn: () => {
      notify('turn/started', {})
      notify('item/started', { item: { type: 'agentMessage', id: 'reply', text: '' } })
    },
    streamText: (text) => notify('item/agentMessage/delta', { itemId: 'reply', delta: text })
  }
}

function claudeStream(sink: StructuredAgentSessionEventSink, schedule: Schedule): Stream {
  const translator = createClaudeJournalTranslator({ sink, schedule })
  let frames = 0
  const streamEvent = (event: Record<string, unknown>) =>
    translator.handle({
      type: 'message',
      sessionId: SESSION,
      message: {
        type: 'stream_event',
        uuid: `frame-${++frames}`,
        session_id: 'claude-session',
        parent_tool_use_id: null,
        event
      }
    })
  return {
    openTurn: () => {
      streamEvent({
        type: 'message_start',
        message: { id: 'message-1', role: 'assistant', content: [] }
      })
      streamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      })
    },
    streamText: (text) =>
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  }
}

type Schedule = ReturnType<typeof heldWindow>['schedule']

function describeRow(body: AgentJournalItemBody): string {
  if (body.kind === 'status') {
    return `note: ${body.text}`
  }
  if (body.kind === 'message') {
    const block = body.blocks[0]
    return `text: ${block?.type === 'text' ? block.text : ''}`
  }
  return body.kind
}

describe.each([
  ['Codex', codexStream],
  ['Claude', claudeStream]
])('%s text streamed inside the coalescing window', (_provider, stream) => {
  it('lands ahead of the note of a Stop issued in that window', async () => {
    await attach()
    const window = heldWindow()
    const provider = stream(acquire.mock.calls.at(-1)![0].events!, window.schedule)
    provider.openTurn()
    provider.streamText(STREAMED)
    const journal: AgentSessionJournal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const turnId = journal.activeTurnId()
    expect(turnId).not.toBeNull()

    const stopped = await host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', { turnId }),
      turnId: turnId!
    })
    expect(stopped).toMatchObject({ ok: true, value: { cancelled: true } })
    window.close()

    const rows = journal
      .snapshot()
      .items.map((item) => describeRow(item.body))
      .filter((row) => row !== 'turn')
    expect(rows).toEqual([`text: ${STREAMED}`, 'note: Cancellation requested.'])
  })
})
