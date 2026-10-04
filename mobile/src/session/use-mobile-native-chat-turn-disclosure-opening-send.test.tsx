// On the phone, as on the desktop: a message sent while the turn ahead is still opening waits after
// that turn's live status, and the live status stays on the turn ahead, never on the waiting one.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session-journal-types'
import { projectNativeChatTranscriptMessages } from '../../../src/shared/native-chat-transcript-projection'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../src/shared/structured-agent-session-outbox'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/structured-agent-session-message-projection'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'

const NOW = 100_000

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalItemBody
): AgentJournalRenderItem {
  return {
    itemId,
    revision: 0,
    sequence,
    observedAt: sequence,
    body,
    turnScope: { kind: 'thread' }
  }
}

const userMessage = (id: string, sequence: number) =>
  item(agentJournalSubmissionKey(id), sequence, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: id }]
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

/** "first" handed over (row 5) with no turn record yet: its turn opens. */
const openingItems = [userMessage('first', 5)]
const openingSubmissions = [submission('first', { acceptedSequence: 3, handedOverAt: NOW })]

const unrecorded = (clientMessageId: string): StructuredAgentSessionOutboxEntry => ({
  clientMessageId,
  sessionId: 'session-1',
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] },
  previewUris: [],
  state: 'dispatching',
  queuedAt: NOW + 100,
  lastAttemptAt: NOW + 100,
  retryAfterUnknownSubmittedAt: null
})

type Disclosure = ReturnType<typeof useMobileNativeChatTurnDisclosure>

function Harness(props: {
  items: AgentJournalRenderItem[]
  submissions: AgentJournalSubmission[]
  outbox: StructuredAgentSessionOutboxEntry[]
  stopping: boolean
  seen: (disclosure: Disclosure) => void
}): null {
  const messages: NativeChatMessage[] = projectNativeChatTranscriptMessages(
    projectStructuredAgentSessionMessages(props.items, props.outbox, props.submissions)
  )
  const disclosure = useMobileNativeChatTurnDisclosure({
    messages,
    enabled: true,
    isWorking: true,
    workingStartedAt: NOW,
    turnJournal: { items: props.items, submissions: props.submissions },
    stopping: props.stopping,
    scopeKey: 'host\0worktree\0tab-a'
  })
  props.seen(disclosure)
  return null
}

describe('a message sent while the turn ahead is still opening, on the phone', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function frame(
    items: AgentJournalRenderItem[],
    submissions: AgentJournalSubmission[],
    outbox: StructuredAgentSessionOutboxEntry[],
    stopping = false
  ): { listed: string[]; waiting: string[]; liveOn: string | undefined } {
    let seen: Disclosure | undefined
    act(() => {
      const element = createElement(Harness, {
        items,
        submissions,
        outbox,
        stopping,
        seen: (disclosure) => {
          seen = disclosure
        }
      })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
    if (!seen) {
      throw new Error('expected the hook to render')
    }
    const disclosure = seen
    const listed = disclosure.listMessages.map((message) => message.id)
    const liveRow = disclosure.listMessages.findIndex(
      (message, index) => disclosure.resolveRow(index, message).turnStatus !== null
    )
    return {
      listed,
      waiting: disclosure.waitingRows.map(({ item: row }) => row.id),
      liveOn: liveRow === -1 ? undefined : listed[liveRow]
    }
  }

  it('keeps the live status on the turn ahead and the unrecorded send waiting after it', () => {
    expect(frame(openingItems, openingSubmissions, [unrecorded('second')])).toEqual({
      listed: [agentJournalSubmissionKey('first')],
      waiting: [agentJournalSubmissionKey('second')],
      liveOn: agentJournalSubmissionKey('first')
    })
  })

  // Accepted at a row above the first send's handover, yet still drawn after its live status.
  it('keeps a queued send waiting after the live status', () => {
    expect(
      frame(
        [...openingItems, userMessage('second', 4)],
        [...openingSubmissions, submission('second', { acceptedSequence: 4 })],
        []
      )
    ).toEqual({
      listed: [agentJournalSubmissionKey('first')],
      waiting: [agentJournalSubmissionKey('second')],
      liveOn: agentJournalSubmissionKey('first')
    })
  })

  it('drops B from the wait when a Stop withdraws it, never listing it above the live status', () => {
    expect(frame(openingItems, openingSubmissions, [unrecorded('b')]).waiting).toEqual([
      agentJournalSubmissionKey('b')
    ])
    const queued = [...openingItems, userMessage('b', 4)]
    const stopping = frame(
      queued,
      [...openingSubmissions, submission('b', { acceptedSequence: 4 })],
      [],
      true
    )
    expect(stopping.waiting).toEqual([agentJournalSubmissionKey('b')])
    expect(stopping.listed).toEqual([agentJournalSubmissionKey('first')])

    const withdrawn = submission('b', {
      acceptedSequence: 4,
      dispatchState: 'rejected',
      resolvedAt: NOW + 200,
      ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
    })
    expect(frame(queued, [...openingSubmissions, withdrawn], [], true)).toEqual({
      listed: [agentJournalSubmissionKey('first')],
      waiting: [],
      liveOn: agentJournalSubmissionKey('first')
    })
  })
})
