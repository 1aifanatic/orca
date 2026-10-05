// The phone's list built from the frames it merged must equal the list a fresh snapshot of the same
// journal builds. Covers journal -> host readers -> phone reducer -> projection -> fold -> turn
// membership and bars; the phone's own hooks, its echo and the host's Stopping are covered by
// mobile-native-chat-merged-snapshot-parity-hooks.test.tsx.

import { describe, expect, it } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import { nativeChatRowsInDrawOrder } from '../../../src/shared/native-chat-turn-grouping'
import {
  nativeChatMessagesWaitingBehindLiveTurn,
  nativeChatTurnMembership
} from '../../../src/shared/native-chat-turn-membership'
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
import {
  NEVER_OPENED,
  stopJournal,
  type StopJournal
} from './mobile-native-chat-stop-journal.test-fixture'

type Drawn = { header: string; rows: { id: string; role: string; line: string }[] }

function apply(
  state: StructuredAgentSessionState,
  events: readonly AgentSessionSubscribeEvent[]
): StructuredAgentSessionState {
  return events.reduce(
    (next, event) => reduceStructuredAgentSession(next, { type: 'event', event }, 0),
    state
  )
}

/** What the phone's list draws: each row in draw order, its content, its turn and that turn's bar. */
function drawn(state: StructuredAgentSessionState): Drawn {
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
  return {
    header: `working ${working} live ${membership.liveTurnKey ?? '-'}`,
    rows: rows.map((row, index) => {
      const turnKey = turnKeys[index]
      const bar = turnKey === undefined ? '-' : JSON.stringify(settledTurns.get(turnKey) ?? 'none')
      const flags = [row.stoppedBeforeStart ? 'stopped' : '', waiting.has(row.id) ? 'waiting' : '']
      const line = [row.id, row.role, ...flags, turnKey ?? '-', bar, JSON.stringify(row.blocks)]
      return { id: row.id, role: row.role, line: line.join(' ') }
    })
  }
}

/**
 * A fresh page starts part way into a long chat, and a turn whose user row it cut off is keyed
 * differently there; so both lists are compared from the fresh page's first user row on.
 */
function comparable(merged: Drawn, fresh: Drawn): { merged: string[]; fresh: string[] } {
  const first = fresh.rows.findIndex((row) => row.role === 'user')
  const from = first === -1 ? fresh.rows.length : first
  const anchor = fresh.rows[from]?.id
  const mergedFrom =
    anchor === undefined ? merged.rows.length : merged.rows.findIndex((row) => row.id === anchor)
  return {
    merged: [
      merged.header,
      ...merged.rows.slice(mergedFrom === -1 ? 0 : mergedFrom).map((row) => row.line)
    ],
    fresh: [fresh.header, ...fresh.rows.slice(from).map((row) => row.line)]
  }
}

/** Every frame from each subscribe point in `starts`, `rowsPerFrame` rows at a time; with how many
 *  of those frames the merged state held only a window of the chat. */
function compareFrames(
  journal: StopJournal,
  starts: readonly number[],
  rowsPerFrame: number
): { differing: string[]; windowed: number } {
  const last = journal.rows.length
  const fresh = new Map<number, Drawn>()
  const freshAt = (upTo: number): Drawn => {
    const cached = fresh.get(upTo)
    if (cached) {
      return cached
    }
    const drawnThen = drawn(apply(EMPTY_STRUCTURED_AGENT_SESSION, [journal.snapshotAt(upTo)]))
    fresh.set(upTo, drawnThen)
    return drawnThen
  }
  const differing: string[] = []
  let windowed = 0
  for (const start of starts) {
    let merged = apply(EMPTY_STRUCTURED_AGENT_SESSION, [journal.snapshotAt(start)])
    for (let upTo = Math.min(start + rowsPerFrame, last); upTo <= last;) {
      merged = apply(
        merged,
        journal.framesTo({ cursor: merged.cursor!, fence: merged.fence! }, upTo)
      )
      windowed += merged.hasOlder ? 1 : 0
      const compared = comparable(drawn(merged), freshAt(upTo))
      if (JSON.stringify(compared.merged) !== JSON.stringify(compared.fresh)) {
        differing.push(`subscribed at ${start}, frame through ${upTo}`)
      }
      upTo = upTo === last ? last + 1 : Math.min(upTo + rowsPerFrame, last)
    }
  }
  return { differing, windowed }
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, index) => from + index)

describe('a short chat: the phone draws the same from merged frames as from a fresh snapshot', () => {
  const journal = stopJournal(8)

  it('draws the send the exit took back with its stop row, from the frame that took it back', () => {
    const fresh = drawn(
      apply(EMPTY_STRUCTURED_AGENT_SESSION, [journal.snapshotAt(journal.takenBack)])
    )
    expect(fresh.rows.slice(-2).map((row) => row.line.split(' ').slice(0, 3).join(' '))).toEqual([
      `orca:${NEVER_OPENED} user stopped`,
      `stopped-before-start:orca:${NEVER_OPENED} system `
    ])
  })

  it.each([1, 2, 3])('from every subscribe point, %i row(s) per frame', (rowsPerFrame) => {
    expect(compareFrames(journal, range(2, journal.rows.length), rowsPerFrame).differing).toEqual(
      []
    )
  })
})

describe('a chat longer than the phone first loads', () => {
  const journal = stopJournal(70)
  const last = journal.rows.length
  // Every 37th row of the history, then every row from the stopped turn on.
  const lastTurns = journal.neverOpenedSent - 40
  const starts = [...range(2, lastTurns).filter((row) => row % 37 === 0), ...range(lastTurns, last)]

  it('draws the same at every frame from each subscribe point, from a window of the chat', () => {
    expect(apply(EMPTY_STRUCTURED_AGENT_SESSION, [journal.snapshotAt(last)]).hasOlder).toBe(true)
    const { differing, windowed } = compareFrames(journal, starts, 1)
    expect(differing).toEqual([])
    expect(windowed).toBeGreaterThan(1_000)
  }, 60_000)
})
