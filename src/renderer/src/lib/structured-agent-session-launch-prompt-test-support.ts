// A new chat's first message as the host answers and then publishes it, for tests of what a launch
// prompt's caller does on delivery. The caller's test mocks `@/runtime/structured-agent-session-client`
// with the two spies handed in here.

import { vi, type Mock } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'

export type LaunchPromptClientMock = { call: Mock; subscribe: Mock }

type FirstMessage = Omit<AgentJournalSubmission, 'clientMessageId'>

export type FirstMessageChange = Partial<FirstMessage>

const QUEUED: FirstMessage = {
  fence: 1,
  payloadFingerprint: 'fingerprint',
  dispatchState: 'pending',
  providerItemId: null,
  reason: null,
  submittedAt: 1,
  resolvedAt: null,
  handoverRecorded: true
}

const RETRYING = (attempts: number): Partial<FirstMessage> => ({
  startRetry: {
    attempts,
    reason: 'An account switch is in progress.',
    rejection: { kind: 'accountSwitchInProgress' },
    failedAt: attempts,
    nextAttemptAt: attempts + 15_000
  }
})

/** What becomes of a first message whose agent's first start fails. */
export const FIRST_START_FAILS = {
  /** The retry starts the agent, which takes the message. */
  retriedThenTaken: [
    RETRYING(1),
    { handedOverAt: 20_000 },
    { dispatchState: 'accepted', resolvedAt: 20_001 }
  ],
  /** The first hand-over's answer is lost, and a late echo proves the agent took it. */
  unknownThenTaken: [
    { handedOverAt: 20_000 },
    { dispatchState: 'unknown' },
    { dispatchState: 'accepted' }
  ],
  /** Every start fails; the last try rejects the message. */
  rejectedAfterTries: [
    RETRYING(1),
    RETRYING(2),
    RETRYING(3),
    { dispatchState: 'rejected', rejection: { kind: 'accountSwitchInProgress' } }
  ],
  /** The person closes the chat while it waits: the host withdraws the message, keeping the start
   *  failure it waited out (structured-agent-session-close-withdraws-first-message.test.ts). */
  chatClosed: [
    RETRYING(1),
    { dispatchState: 'rejected', rejection: { kind: 'accountSwitchInProgress' } }
  ]
} satisfies Record<string, Partial<FirstMessage>[]>

export type FirstMessageStream = {
  /** Publishes the message's next state, as a journal batch. */
  next: (change: Partial<FirstMessage>) => void
  /** Whether the reader of the stream is still subscribed. */
  open: () => boolean
}

/**
 * Answers the send as accepted-but-queued and hands back the stream the host then publishes: a
 * snapshot first, as the host's subscribe always opens, then batches. `opened` is what the message
 * already is when the reader subscribes, e.g. taken in the gap between the send's answer and then.
 */
export function firstMessageStream(
  client: LaunchPromptClientMock,
  clientMessageId: string,
  opened: Partial<FirstMessage> = {}
): Promise<FirstMessageStream> {
  const answered: AgentJournalSubmission = { clientMessageId, ...QUEUED }
  let current: AgentJournalSubmission = { ...answered, ...opened }
  client.call.mockResolvedValue({
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value: { clientMessageId, submission: answered }
  })
  return new Promise((resolve) => {
    client.subscribe.mockImplementation(
      async (
        _target: unknown,
        _params: unknown,
        onEvent: (e: AgentSessionSubscribeEvent) => void
      ) => {
        let subscribed = true
        const publish = (submission: AgentJournalSubmission): void =>
          onEvent({
            type: 'batch',
            sessionId: 'session-1',
            batch: {
              cursor: { epoch: 'epoch-1', sequence: 2 },
              items: [],
              removedItemIds: [],
              submissions: [submission]
            }
          })
        queueMicrotask(() => {
          onEvent({
            type: 'snapshot',
            sessionId: 'session-1',
            fence: 2,
            page: {
              sessionId: 'session-1',
              epoch: 'epoch-1',
              direction: 'tail',
              items: [],
              removedItemIds: [],
              submissions: [current],
              window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch-1', sequence: 2 } },
              hasOlder: false,
              hasNewer: false
            }
          })
          resolve({
            next: (change) => {
              current = { ...current, ...change }
              publish(current)
            },
            open: () => subscribed
          })
        })
        return {
          unsubscribe: vi.fn(() => {
            subscribed = false
          })
        }
      }
    )
  })
}

/** Plays a whole outcome on the stream. */
export function play(stream: FirstMessageStream, changes: readonly Partial<FirstMessage>[]): void {
  for (const change of changes) {
    stream.next(change)
  }
}
