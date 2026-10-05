// What the phone draws from the frames it merged must equal what it draws from a fresh snapshot of
// the same journal, at every frame and whichever frame it subscribed at. Against the host's own
// fold and readers, then the phone's reducer, projection, fold and turn membership. The journal is
// shaped like a long chat whose last send never opened and was taken back at the child's exit,
// right after a send made while a Stop was ending the turn before it.

import { describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalCursor,
  type AgentJournalItemBody,
  type AgentJournalTurnScope
} from '../../../src/shared/agent-session-journal-types'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState,
  resolveJournalItemId
} from '../../../src/main/native-chat/agent-session-journal/journal-reducer'
import type { JournalRow } from '../../../src/main/native-chat/agent-session-journal/journal-row-schema'
import type { AgentSessionJournal } from '../../../src/main/native-chat/agent-session-journal/journal-store'
import {
  readAgentSessionHistory,
  readAgentSessionHydrationPage
} from '../../../src/main/native-chat/agent-session-wire/agent-session-history-page'
import { nativeChatRowsInDrawOrder } from '../../../src/shared/native-chat-turn-grouping'
import {
  nativeChatMessagesWaitingBehindLiveTurn,
  nativeChatTurnMembership
} from '../../../src/shared/native-chat-turn-membership'
import { DISPATCH_REJECTED_CANCELLED } from '../../../src/shared/structured-agent-session-dispatch-rejection'
import { activeStructuredAgentSessionTurnId } from '../../../src/shared/structured-agent-session-live-turn'
import { isStructuredAgentSessionMainAgentWorking } from '../../../src/shared/structured-agent-session-main-agent-working'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/structured-agent-session-message-projection'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../src/shared/structured-agent-session-reducer'
import { selectStructuredAgentTurnBars } from '../../../src/shared/structured-agent-session-turn-timing'
import {
  buildMobileNativeChatTransientData,
  foldMobileNativeChatMessages
} from './mobile-native-chat-render-data'

const SESSION = 'codex_session'
const THREAD = 'thread-1'
const EPOCH = 'epoch-1'
const HISTORY_TURNS = 8

type RowInput = {
  [K in JournalRow['kind']]: Omit<
    Extract<JournalRow, { kind: K }>,
    'v' | 'epoch' | 'seq' | 'fence' | 'ts'
  >
}[JournalRow['kind']]

function journalRows(): JournalRow[] {
  const rows: JournalRow[] = []
  let fence = 0
  const add = (row: RowInput): void => {
    const seq = rows.length + 1
    const envelope = { v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION, epoch: EPOCH, seq, fence }
    const stamped = { ...row, ...envelope, ts: 1_000 * seq }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `row` is one arm of the union less the envelope, and the envelope added here is the same for every arm.
    rows.push(stamped as JournalRow)
  }
  const turnItem = (turnId: string): string => `legacy:codex:${SESSION}:turn-lifecycle%3A${turnId}`
  const answerItem = (turnId: string): string => `codex:${THREAD}:${turnId}:1`
  const inTurn = (turnId: string): AgentJournalTurnScope => ({
    kind: 'turn',
    turnItemId: turnItem(turnId)
  })
  const answer = (text: string): AgentJournalItemBody => ({
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text }]
  })
  const send = (id: string): void => {
    add({
      kind: 'submission',
      clientMessageId: id,
      payloadFingerprint: id,
      providerHandle: { kind: 'codex', threadId: THREAD },
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] },
      handoverRecorded: true,
      origin: 'client'
    })
    add({
      kind: 'dispatch',
      clientMessageId: id,
      state: 'pending',
      providerItemId: null,
      reason: null,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  }
  const stopEvent = (turnId?: string): void =>
    add({
      kind: 'tombstone',
      itemId: 'orca:stop-event',
      revision: 1,
      stopEvent: { reason: 'user-stop', at: 1, ...(turnId ? { turnId } : {}) }
    })
  // A turn the provider opened for `id`; a Stop ends it when `stopped`.
  const turn = (id: string, turnId: string, stopped: boolean): void => {
    const started = { turnId, startedAt: 1 }
    const record = turnItem(turnId)
    add({
      kind: 'item',
      itemId: record,
      revision: 1,
      body: {
        kind: 'turn',
        state: 'running',
        userItemId: `codex:${THREAD}:${turnId}:0`,
        ...started
      },
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    add({
      kind: 'item',
      itemId: record,
      revision: 2,
      body: { kind: 'turn', state: 'running', userItemId: `orca:${id}`, ...started },
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    add({
      kind: 'dispatch',
      clientMessageId: id,
      state: 'accepted',
      providerItemId: `codex:${THREAD}:${turnId}:0`,
      reason: null
    })
    for (const revision of [1, 2, 3]) {
      add({
        kind: 'item',
        itemId: answerItem(turnId),
        revision,
        body: answer(`part ${revision}`),
        turnScope: inTurn(turnId)
      })
    }
    if (stopped) {
      stopEvent(turnId)
    }
    add({
      kind: 'lifecycle-batch',
      settlementId: `turn-completed:${turnId}`,
      mutations: [
        {
          kind: 'item',
          itemId: answerItem(turnId),
          revision: 4,
          body: answer('done'),
          turnScope: inTurn(turnId)
        },
        {
          kind: 'item',
          itemId: record,
          revision: 3,
          body: {
            kind: 'turn',
            state: stopped ? 'interrupted' : 'completed',
            userItemId: `orca:${id}`,
            completedAt: 2,
            ...started
          },
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      ]
    })
    if (stopped) {
      add({
        kind: 'item',
        itemId: `orca:stop%3A${turnId}`,
        revision: 1,
        body: { kind: 'status', text: 'Cancellation requested.' },
        turnScope: inTurn(turnId)
      })
    }
  }

  add({
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: THREAD }
  })
  fence = 1
  for (let index = 0; index < HISTORY_TURNS; index += 1) {
    send(`history-${index}`)
    turn(`history-${index}`, `t-history-${index}`, index % 2 === 1)
  }
  // A Stop ends a turn, and a send made while it does runs once it has.
  send('stopped')
  turn('stopped', 't-stopped', true)
  send('sent-while-stopping')
  turn('sent-while-stopping', 't-sent-while-stopping', false)
  // A send the provider never opened; a turn-less Stop ends the child, whose exit takes it back.
  send('never-opened')
  stopEvent()
  add({
    kind: 'dispatch',
    clientMessageId: 'never-opened',
    state: 'rejected',
    providerItemId: null,
    reason: DISPATCH_REJECTED_CANCELLED,
    rejection: { kind: 'cancelled' },
    recovered: true
  })
  // The next send starts a new child.
  fence = 2
  send('recovery')
  turn('recovery', 't-recovery', false)
  return rows
}

const ROWS = journalRows()
const TAKEN_BACK = ROWS.find((row) => row.kind === 'dispatch' && row.state === 'rejected')!.seq

/** The host's journal after `upTo`, as its readers read it. */
function journalAt(upTo: number): AgentSessionJournal {
  const state = createJournalReducerState(SESSION, EPOCH)
  const applied = ROWS.filter((row) => row.seq <= upTo)
  for (const row of applied) {
    applyJournalRow(state, row)
  }
  const snapshot = renderJournalState(state)
  const journal = {
    isReadOnly: false,
    snapshot: () => snapshot,
    cursor: () => snapshot.cursor,
    canonicalItemId: (itemId: string) => resolveJournalItemId(state, itemId),
    readSince: (cursor: AgentJournalCursor, limit?: number) => ({
      ok: true as const,
      rows: applied.filter((row) => row.seq > cursor.sequence).slice(0, limit),
      cursor: snapshot.cursor
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the history readers call only the members above.
  return journal as unknown as AgentSessionJournal
}

const fenceAt = (upTo: number): number => ROWS[upTo - 1]!.fence

function freshState(upTo: number): StructuredAgentSessionState {
  const fence = fenceAt(upTo)
  const page = readAgentSessionHydrationPage(journalAt(upTo), fence)
  const event = { type: 'snapshot' as const, sessionId: SESSION, page, fence, hostNow: 0 }
  return reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, { type: 'event', event }, 0)
}

/** The batches a subscriber at `state`'s cursor gets once the journal reaches `upTo`. */
function mergeUpTo(state: StructuredAgentSessionState, upTo: number): StructuredAgentSessionState {
  const journal = journalAt(upTo)
  let next = state
  for (;;) {
    const cursor = next.cursor!
    const result = readAgentSessionHistory(journal, {
      sessionId: SESSION,
      direction: 'after',
      cursor,
      limit: 200
    })
    if (!result.ok) {
      throw new Error(`the host reset the stream: ${result.reset}`)
    }
    const { page } = result
    if (page.window.nextCursor.sequence <= cursor.sequence) {
      return next
    }
    const batch = {
      cursor: page.window.nextCursor,
      items: page.items,
      removedItemIds: page.removedItemIds,
      submissions: page.submissions
    }
    const event = {
      type: 'batch' as const,
      sessionId: SESSION,
      batch,
      fence: fenceAt(upTo),
      hostNow: 0
    }
    next = reduceStructuredAgentSession(next, { type: 'event', event }, 0)
    if (!page.hasNewer) {
      return next
    }
  }
}

/** What the phone's list draws: its rows in draw order, each with its turn and its turn's bar. */
function drawn(state: StructuredAgentSessionState): string[] {
  const messages = projectStructuredAgentSessionMessages(state.items, [], state.submissions)
  const folded = foldMobileNativeChatMessages(messages)
  const { data } = buildMobileNativeChatTransientData({
    messages,
    folded,
    streaming: null,
    pending: []
  })
  const membership = nativeChatTurnMembership(data, state)
  const rows = nativeChatRowsInDrawOrder(data, membership.drawOrder)
  const turnKeys = nativeChatRowsInDrawOrder(membership.turnKeys, membership.drawOrder)
  const waiting = nativeChatMessagesWaitingBehindLiveTurn(rows, state.items)
  const turnId = activeStructuredAgentSessionTurnId(state.items)
  const { settledTurns } = selectStructuredAgentTurnBars(state.items, state.submissions, turnId)
  const working = isStructuredAgentSessionMainAgentWorking(turnId, state.submissions, state.fence)
  return [
    `working ${working} live ${membership.liveTurnKey ?? '-'}`,
    ...rows.map((row, index) => {
      const turnKey = turnKeys[index]
      const bar = turnKey === undefined ? '-' : JSON.stringify(settledTurns.get(turnKey) ?? 'none')
      return [
        row.id,
        row.role,
        row.stoppedBeforeStart ? 'stopped' : '',
        waiting.has(row.id) ? 'waiting' : '',
        turnKey ?? '-',
        bar
      ].join(' ')
    })
  ]
}

const FRESH = new Map(ROWS.map((row) => [row.seq, drawn(freshState(row.seq))]))

describe('the phone, from merged frames and from a fresh snapshot', () => {
  it('draws the send the exit took back with its stop row, from the frame that took it back', () => {
    expect(
      FRESH.get(TAKEN_BACK)!
        .slice(-2)
        .map((line) => line.split(' ').slice(0, 3).join(' '))
    ).toEqual(['orca:never-opened user stopped', 'stopped-before-start:orca:never-opened system '])
  })

  // Every subscribe point, every later frame, and frames that carry several rows at once.
  it.each([1, 2, 3])('draws the same at every frame, %i row(s) per frame', (rowsPerFrame) => {
    const last = ROWS.length
    const differing: string[] = []
    for (let start = 2; start < last; start += 1) {
      let merged = freshState(start)
      for (let upTo = start + rowsPerFrame; upTo <= last; upTo += rowsPerFrame) {
        merged = mergeUpTo(merged, upTo)
        if (JSON.stringify(drawn(merged)) !== JSON.stringify(FRESH.get(upTo))) {
          differing.push(`subscribed at ${start}, frame through ${upTo}`)
        }
      }
    }
    expect(differing).toEqual([])
  })
})
