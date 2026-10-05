// An outbox copy of a message the host recorded and then rejected draws it only while the host's row
// is not loaded, and leaves, with no user action, on the batch or page that loads that row. It never
// offers a control: sending it again is a new message. Nothing is stored to say it was rejected:
// the held submission says so.

import { expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../../shared/agent-session-wire'
import { DISPATCH_REJECTED_HOST_RESTARTED } from '../../../../shared/structured-agent-session-dispatch-rejection'
import { reconcileStructuredAgentSessionOutboxWithQueue } from '../../../../shared/structured-agent-session-draft-hand-off'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { admitStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox-admission'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../../shared/structured-agent-session-reducer'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

const NO_CARDS: readonly string[] = []
const MESSAGE_ID = agentJournalSubmissionKey('m')
const WORDS = 'Orca restarted before this message was sent.'
const NOT_SENT = { muted: true, text: WORDS }

function answer(sequence: number): AgentJournalRenderItem {
  return {
    itemId: `a-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] }
  }
}

function hostRow(sequence: number): AgentJournalRenderItem {
  return {
    itemId: MESSAGE_ID,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'sent text' }] }
  }
}

const REJECTED: AgentJournalSubmission = {
  clientMessageId: 'm',
  fence: 1,
  payloadFingerprint: 'm',
  dispatchState: 'rejected',
  providerItemId: null,
  reason: DISPATCH_REJECTED_HOST_RESTARTED,
  rejection: { kind: 'hostRestarted' },
  submittedAt: 10,
  resolvedAt: 1100
}

function copy(patch: Partial<StructuredAgentSessionOutboxEntry> = {}) {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: 'm',
      sessionId: 's',
      text: 'sent text',
      attachments: [],
      queuedAt: 10
    }),
    ...patch
  }
}

/** A copy whose send went out, as the outbox stores it however the host answered. */
const SENT_COPY = copy({ state: 'dispatching', lastAttemptAt: 9 })

function page(
  items: AgentJournalRenderItem[],
  submissions: AgentJournalSubmission[]
): AgentSessionHistoryPage {
  const oldest = items[0]?.sequence ?? 0
  return {
    sessionId: 's',
    epoch: 'e',
    direction: 'tail',
    items,
    removedItemIds: [],
    submissions,
    window: {
      oldest: { epoch: 'e', sequence: oldest },
      newest: { epoch: 'e', sequence: items.at(-1)?.sequence ?? 0 },
      nextCursor: { epoch: 'e', sequence: oldest }
    },
    liveCursor: { epoch: 'e', sequence: items.at(-1)?.sequence ?? 0 },
    hasOlder: true,
    hasNewer: false
  }
}

function opened(items: AgentJournalRenderItem[], submissions: AgentJournalSubmission[]) {
  return reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'event',
    event: { type: 'snapshot', sessionId: 's', fence: 1, page: page(items, submissions) }
  })
}

const WINDOW = Array.from({ length: 100 }, (_, index) => answer(1000 + index))

/** What the chat draws for this message, and the notice its row carries. */
function shown(
  state: StructuredAgentSessionState,
  outbox: readonly StructuredAgentSessionOutboxEntry[]
) {
  const kept = reconcileStructuredAgentSessionOutboxWithQueue(
    outbox,
    state.submissions,
    state.items
  )
  const rows = projectStructuredAgentSessionMessages(state.items, kept, state.submissions, NO_CARDS)
    .filter((message) => message.role === 'user')
    .map(({ id, unsent }) => ({ id, unsent }))
  const notice = structuredAgentSessionDeliveryNotices(
    kept,
    'Claude',
    state.submissions,
    [],
    undefined,
    false,
    NO_CARDS,
    state.items
  ).get(MESSAGE_ID)
  return { kept, rows, notice }
}

it('leaves on the live batch that rejects it on a host that places the row at the rejection', () => {
  let state = opened(WINDOW, [])
  state = reduceStructuredAgentSession(state, {
    type: 'event',
    event: {
      type: 'batch',
      sessionId: 's',
      batch: {
        cursor: { epoch: 'e', sequence: 1100 },
        items: [hostRow(1100)],
        removedItemIds: [],
        submissions: [REJECTED]
      }
    }
  })

  expect(shown(state, [SENT_COPY])).toEqual({
    kept: [],
    rows: [{ id: MESSAGE_ID, unsent: true }],
    notice: NOT_SENT
  })
})

it('leaves on the page that opens the chat when that page holds the row', () => {
  const state = opened([...WINDOW, hostRow(1100)], [REJECTED])

  expect(shown(state, [SENT_COPY])).toEqual({
    kept: [],
    rows: [{ id: MESSAGE_ID, unsent: true }],
    notice: NOT_SENT
  })
})

it('draws once, with no control, while its row is outside the window, and leaves when that page loads', () => {
  // An older host leaves the row where it was sent; the live batch brings only its record.
  let state = reduceStructuredAgentSession(opened(WINDOW, []), {
    type: 'event',
    event: {
      type: 'batch',
      sessionId: 's',
      batch: {
        cursor: { epoch: 'e', sequence: 1100 },
        items: [hostRow(10)],
        removedItemIds: [],
        submissions: [REJECTED]
      }
    }
  })
  const before = shown(state, [SENT_COPY])
  expect(before.kept).toEqual([SENT_COPY])
  expect(before.rows).toEqual([{ id: MESSAGE_ID, unsent: true }])
  expect(before.notice).toEqual(NOT_SENT)

  // Scrolling back loads the page; no control on the copy is involved.
  state = reduceStructuredAgentSession(state, {
    type: 'older-page',
    requestedCursor: { epoch: 'e', sequence: 1000 },
    page: page(
      [hostRow(10), ...Array.from({ length: 5 }, (_, index) => answer(995 + index))],
      [REJECTED]
    )
  })
  expect(shown(state, before.kept)).toEqual({
    kept: [],
    rows: [{ id: MESSAGE_ID, unsent: true }],
    notice: NOT_SENT
  })
})

// After a reopen the page may hold neither the row nor its submission; the copy keeps the host's
// fact, so it still draws not sent in the host's words, and nothing sends it again.
it("draws a stored copy of the host's rejection whose record is not held, and never sends it", () => {
  const state = opened(WINDOW, [])
  const kept = copy({
    state: 'unconfirmed',
    lastAttemptAt: 9,
    recordedRejection: {
      reason: DISPATCH_REJECTED_HOST_RESTARTED,
      rejection: { kind: 'hostRestarted' }
    }
  })
  const after = shown(state, [kept])

  expect(after.kept).toEqual([kept])
  expect(after.rows).toEqual([{ id: MESSAGE_ID, unsent: true }])
  expect(after.notice).toEqual(NOT_SENT)
  // Unconfirmed, as a reopen reads any copy: the host's fact still keeps every send off it.
  expect(admitStructuredAgentSessionOutboxEntry(after.kept)).toEqual({ state: 'idle', entry: null })
})
