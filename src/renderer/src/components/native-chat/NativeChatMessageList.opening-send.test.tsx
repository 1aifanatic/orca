// @vitest-environment happy-dom
// A message sent while the turn ahead is still opening waits at the tail, after that turn's live
// status, never as a bubble above it: the host holds it until the turn opens. The frames here are
// the ones a person sees during that wait, and through a Stop pressed during it.

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnScope
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'
import { selectStructuredAgentSettledTurns } from '../../../../shared/structured-agent-session-turn-timing'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

const THREAD: AgentJournalTurnScope = { kind: 'thread' }
const NOW = 100_000

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalItemBody
): AgentJournalRenderItem {
  return { itemId, revision: 0, sequence, observedAt: sequence, body, turnScope: THREAD }
}

const userMessage = (id: string, sequence: number, text: string) =>
  item(agentJournalSubmissionKey(id), sequence, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }]
  })

function submission(
  clientMessageId: string,
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: NOW,
    resolvedAt: null,
    handoverRecorded: true,
    ...overrides
  }
}

/** A finished warm-up, then "first" handed over (row 5) with no turn record yet: its turn opens. */
function openingFirst(): {
  items: AgentJournalRenderItem[]
  submissions: AgentJournalSubmission[]
} {
  return {
    items: [
      userMessage('warm', 1, 'warm up'),
      item('turn-warm', 2, {
        kind: 'turn',
        turnId: 'turn-warm',
        state: 'completed',
        outcome: 'success',
        userItemId: agentJournalSubmissionKey('warm'),
        startedAt: 1_000,
        completedAt: 2_000
      }),
      userMessage('first', 5, 'first')
    ],
    submissions: [
      submission('warm', { dispatchState: 'accepted', resolvedAt: 2_000 }),
      submission('first', { acceptedSequence: 3, handedOverAt: NOW })
    ]
  }
}

/** This client's own send the host has not recorded yet: its lane still runs the first handover. */
const unrecorded = (clientMessageId: string, text: string): StructuredAgentSessionOutboxEntry => ({
  clientMessageId,
  sessionId: 'session-1',
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
  previewUris: [],
  state: 'dispatching',
  queuedAt: NOW + 100,
  lastAttemptAt: NOW + 100,
  retryAfterUnknownSubmittedAt: null
})

function frame(
  items: AgentJournalRenderItem[],
  submissions: AgentJournalSubmission[],
  outbox: StructuredAgentSessionOutboxEntry[],
  stopping = false
): React.JSX.Element {
  return (
    <NativeChatMessageList
      session={{
        messages: projectStructuredAgentSessionMessages(items, outbox, submissions),
        status: 'ready',
        sessionId: 'session-1',
        agent: 'codex',
        hasMore: false,
        loadingEarlier: false,
        olderHistoryGeneration: 0,
        loadEarlier: vi.fn(),
        readPhase: 'ready'
      }}
      journalItems={items}
      journalSubmissions={submissions}
      settledTurns={selectStructuredAgentSettledTurns(items, submissions)}
      isWorking
      workingStartedAt={NOW}
      stopping={stopping}
      expandSignal={false}
      fontScale={1}
    />
  )
}

function follows(later: HTMLElement, earlier: HTMLElement): boolean {
  return Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING)
}

/** The live turn's status, which carries the first send's working clock. */
const liveStatus = () => screen.getByText(/^Working for/)
/** The live turn's activity line, the last thing the live turn draws. */
const liveActivity = () => screen.getByText(/^(Working|Stopping)…$/)

/** `text` is drawn after the live turn: its status and its activity line. */
function waitsAtTheTail(text: string): void {
  expect(follows(screen.getByText(text), liveStatus())).toBe(true)
  expect(follows(screen.getByText(text), liveActivity())).toBe(true)
}

describe('a message sent while the turn ahead is still opening', () => {
  it('waits at the tail after the live status while the host has not recorded it yet', () => {
    const { items, submissions } = openingFirst()

    render(frame(items, submissions, [unrecorded('second', 'second')]))

    expect(follows(liveStatus(), screen.getByText('first'))).toBe(true)
    waitsAtTheTail('second')
  })

  // Accepted, and so placed at the row that accepted it, which is above the first send's handover.
  it('waits at the tail after the live status once the host holds it queued', () => {
    const { items, submissions } = openingFirst()

    render(
      frame(
        [...items, userMessage('second', 4, 'second')],
        [...submissions, submission('second', { acceptedSequence: 4 })],
        []
      )
    )

    expect(follows(liveStatus(), screen.getByText('first'))).toBe(true)
    waitsAtTheTail('second')
  })

  // A Stop withdraws what is still queued: B goes from the tail, never drawn above the live turn.
  it('leaves the tail when a Stop withdraws it, with no frame above the live status', () => {
    const { items, submissions } = openingFirst()
    const view = render(frame(items, submissions, [unrecorded('b', 'B')]))
    waitsAtTheTail('B')

    // Pressed: Stopping, with B now recorded and queued behind the first send.
    const queued = [...items, userMessage('b', 4, 'B')]
    view.rerender(
      frame(queued, [...submissions, submission('b', { acceptedSequence: 4 })], [], true)
    )
    waitsAtTheTail('B')

    // Withdrawn with the queue.
    const withdrawn = submission('b', {
      acceptedSequence: 4,
      dispatchState: 'rejected',
      resolvedAt: NOW + 200,
      ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
    })
    view.rerender(frame(queued, [...submissions, withdrawn], [], true))
    expect(screen.queryByText('B')).toBeNull()
  })

  // The Q2 frame: Stop pressed while the host has not recorded B yet, its lane still busy.
  it('keeps an unrecorded B after the Stopping line, and a message typed while Stopping too', () => {
    const { items, submissions } = openingFirst()
    const view = render(frame(items, submissions, [unrecorded('b', 'B')], true))
    waitsAtTheTail('B')

    const typedWhileStopping: StructuredAgentSessionOutboxEntry = {
      ...unrecorded('c', 'C'),
      queuedAt: NOW + 300,
      lastAttemptAt: NOW + 300,
      sentWhileStopping: true
    }
    view.rerender(frame(items, submissions, [unrecorded('b', 'B'), typedWhileStopping], true))
    waitsAtTheTail('B')
    waitsAtTheTail('C')
  })

  // The host holds nothing for a send only the user's Retry sends again, so it stays where it is.
  it.each([
    ['unconfirmed', { state: 'unconfirmed' as const, retryAfterUnknownSubmittedAt: NOW - 50_000 }],
    ['outlived by a Stop', { state: 'queued' as const, outlivedStop: true as const }]
  ])('does not move a send waiting on Retry (%s) behind the opening turn', (_, retry) => {
    const { items, submissions } = openingFirst()
    const awaitingRetry: StructuredAgentSessionOutboxEntry = {
      ...unrecorded('c', 'C'),
      queuedAt: NOW - 50_000,
      lastAttemptAt: NOW - 50_000,
      ...retry
    }

    render(frame(items, submissions, [awaitingRetry]))

    expect(follows(liveActivity(), screen.getByText('C'))).toBe(true)
  })
})
