import { describe, expect, it, vi } from 'vitest'
import {
  OrchestrationStructuredMailboxPointerDelivery,
  type StructuredMailboxPointerHost,
  type StructuredMailCard,
  type StructuredPointerSendOutcome
} from './structured-mailbox-pointer-delivery'
import type { MessageRow } from './db'
import type { StructuredPointerOperationRow } from './db/messages/structured-pointer-operation-store'
import {
  structuredPointerBatchFingerprint,
  type StructuredPointerSubmission
} from './structured-pointer-operation-id'
import type { StructuredWorkerIdentity } from '../structured-worker-identity'

const IDENTITY: StructuredWorkerIdentity = {
  handle: 'structworker_1',
  sessionId: 'session-1',
  agent: 'claude',
  paneKey: 'structured-agent-session-session-1:11111111-1111-4111-a111-111111111111',
  processIncarnation: 'structured:session-1',
  worktreeId: 'wt_1',
  hostScope: { kind: 'local', hostId: 'local' }
}

function mail(id: string, overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id,
    run_id: 'run_1',
    from_handle: 'term_coord',
    to_handle: 'dispatch:d1',
    subject: `subject ${id}`,
    body: `body ${id}`,
    type: 'status',
    priority: 'normal',
    thread_id: null,
    payload: null,
    read: 0,
    sequence: 3,
    created_at: '2026-01-01 00:00:00',
    delivered_at: null,
    sender_pane_key: null,
    ...overrides
  }
}

function mailCard(
  messageIds: string[],
  fields: Partial<StructuredMailCard> = {}
): StructuredMailCard {
  return { mailbox: 'dispatch:d1', messageIds, unsent: false, accepted: false, ...fields }
}

function harness(options: {
  /** False: the session cannot be read (not attached). */
  attached?: boolean
  outcome?: StructuredPointerSendOutcome
  /** The coordinator of this worker's Run is mid-batch: it checked and has not acked yet. */
  outstandingRunDelivery?: boolean
  outstandingOwnDelivery?: boolean
  /** The mailbox this worker owns; its own handle for direct peer mail outside a dispatch. */
  mailbox?: string
  dispatchId?: string | null
  unread?: MessageRow[]
}) {
  const mailbox = options.mailbox ?? 'dispatch:d1'
  const dispatchId = options.dispatchId === undefined ? 'd1' : options.dispatchId
  let attached = options.attached ?? true
  // The session's recorded sends and mail cards, as its journal and queue report them.
  let submissions: StructuredPointerSubmission[] = []
  let cards: StructuredMailCard[] = []
  let unread = options.unread ?? [mail('m1')]
  const read = new Set<string>()
  const markAsDelivered = vi.fn((ids: string[]) => {
    unread = unread.filter((message) => !ids.includes(message.id))
  })
  const markAsReadAndDelivered = vi.fn((ids: string[]) => {
    ids.forEach((id) => read.add(id))
    unread = unread.filter((message) => !ids.includes(message.id))
  })
  const send: StructuredMailboxPointerHost['send'] = vi.fn(
    async () => options.outcome ?? { kind: 'sent' as const, state: 'accepted' as const }
  )
  const sendMock = vi.mocked(send)
  const stored = new Map<string, StructuredPointerOperationRow>()
  const db = {
    getDispatchContextById: () => ({ run_id: 'run_1' }),
    hasOutstandingMailboxDelivery: (handle: string) =>
      ((options.outstandingRunDelivery ?? false) && handle.startsWith('run:')) ||
      ((options.outstandingOwnDelivery ?? false) && !handle.startsWith('run:')),
    getUndeliveredUnreadMessages: () => unread,
    getMessageById: (id: string) => ({ id, read: read.has(id) ? 1 : 0 }),
    markAsDelivered,
    markAsReadAndDelivered,
    getStructuredPointerOperation: (key: string) => stored.get(key),
    putStructuredPointerOperation: (row: StructuredPointerOperationRow) =>
      stored.set(row.mailbox_handle, row),
    deleteStructuredPointerOperation: (key: string) => stored.delete(key)
  }
  const delivery = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db as never,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: (mailboxHandle) =>
      mailboxHandle === mailbox ? { sessionId: IDENTITY.sessionId, dispatchId } : null,
    getCliCommand: () => 'orca-dev',
    host: {
      readFacts: async () => (attached ? { submissions, mailCards: cards } : null),
      readHandedOffMailCards: async () => (attached ? cards : null),
      currentFence: () => 4,
      send
    }
  })
  return {
    delivery,
    markAsDelivered,
    markAsReadAndDelivered,
    send: sendMock,
    stored,
    setAttached: (next: boolean) => {
      attached = next
    },
    setSubmissions: (next: StructuredPointerSubmission[]) => {
      submissions = next
    },
    setCards: (next: StructuredMailCard[]) => {
      cards = next
    },
    setUnread: (next: MessageRow[]) => {
      unread = next
    }
  }
}

/** The text of the turn a send carried. */
function sentText(send: ReturnType<typeof harness>['send'], call = 0): string {
  const [block] = send.mock.calls[call]![0].body.blocks
  return block?.type === 'text' ? block.text : ''
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('structured mailbox delivery', () => {
  it('claims only mailboxes whose assignee is a structured worker', () => {
    const { delivery } = harness({})
    expect(delivery.deliverForHandle('dispatch:d1')).toBe(true)
    expect(delivery.deliverForHandle('run:run_1')).toBe(false)
  })

  it('sends the mail itself as the turn, and marks it read once the chat accepts it', async () => {
    const { delivery, markAsReadAndDelivered, send } = harness({})
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].operationId).toMatch(/^\d{13}-[0-9a-f]{32}$/)
    expect(sentText(send)).toBe(
      [
        '[message from term_coord]',
        'Type: status',
        'Subject: subject m1',
        'body m1',
        '[Reply: orca-dev orchestration reply --id m1 --body "..."]'
      ].join('\n')
    )
    expect(send.mock.calls[0]![0].source).toMatchObject({
      senders: [{ party: { address: 'term_coord' } }],
      orchestration: {
        message: 'mail',
        mailbox: 'dispatch:d1',
        dispatchId: 'd1',
        messages: [{ messageId: 'm1', runId: 'run_1', from: 'term_coord' }]
      }
    })
    expect(markAsReadAndDelivered).toHaveBeenCalledWith(['m1'])
  })

  it("sends a mailbox's unread mail as one turn, in mail order, each message naming its sender", async () => {
    const { delivery, send, markAsReadAndDelivered } = harness({
      unread: [
        mail('m1'),
        mail('m2', {
          from_handle: 'term_worker',
          type: 'worker_done',
          priority: 'high',
          payload: '{"taskId":"t1","outcome":"succeeded"}'
        })
      ]
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    const [first, second] = sentText(send).split('\n\n')
    expect(first).toMatch(/^\[message from term_coord\]\nType: status\n/)
    expect(second).toBe(
      [
        '[message from term_worker]',
        'Type: worker_done [HIGH]',
        'Subject: subject m2',
        'body m2',
        '[Payload: {"taskId":"t1","outcome":"succeeded"}]',
        '[Reply: orca-dev orchestration reply --id m2 --body "..."]'
      ].join('\n')
    )
    expect(send.mock.calls[0]![0].source.senders.map(({ party }) => party.address)).toEqual([
      'term_coord',
      'term_worker'
    ])
    expect(markAsReadAndDelivered).toHaveBeenCalledWith(['m1', 'm2'])
  })

  it('delivers direct peer mail outside a dispatch through the worker`s own handle', async () => {
    const { delivery, send, markAsReadAndDelivered } = harness({
      mailbox: IDENTITY.handle,
      dispatchId: null,
      unread: [mail('m1', { to_handle: IDENTITY.handle })]
    })
    expect(delivery.deliverForHandle(IDENTITY.handle)).toBe(true)
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].dispatchId).toBeNull()
    // The reply names the mailbox it came to, as `check` prints it.
    expect(sentText(send)).toContain(
      `[Reply: orca-dev orchestration reply --id m1 --from ${IDENTITY.handle} --body "..."]`
    )
    expect(markAsReadAndDelivered).toHaveBeenCalledWith(['m1'])
  })

  it('retains mail when the dispatch settles unknown', async () => {
    const { delivery, markAsDelivered, markAsReadAndDelivered } = harness({
      outcome: { kind: 'sent', state: 'unknown' }
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(markAsDelivered).not.toHaveBeenCalled()
    expect(markAsReadAndDelivered).not.toHaveBeenCalled()
  })

  it('leaves mail a busy chat queued as a card unread, and pushes it no more', async () => {
    const { delivery, send, markAsDelivered, markAsReadAndDelivered, stored } = harness({
      outcome: { kind: 'queued' }
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
    expect(markAsReadAndDelivered).not.toHaveBeenCalled()
    expect(stored.has('dispatch:d1')).toBe(false)
  })

  it("marks a card's mail read on the journal edge after the chat accepted its hand-off", async () => {
    const { delivery, markAsReadAndDelivered, setCards } = harness({ unread: [] })
    setCards([
      mailCard(['m1', 'm2'], { accepted: true }),
      // Handed off but not taken, or still in the queue: its mail stays unread.
      mailCard(['m3']),
      mailCard(['m4'], { unsent: true })
    ])
    delivery.onJournalActivity('session-1')
    await flush()
    expect(markAsReadAndDelivered).toHaveBeenCalledTimes(1)
    expect(markAsReadAndDelivered).toHaveBeenCalledWith(['m1', 'm2'])
    // Read once: a later edge writes nothing.
    delivery.onJournalActivity('session-1')
    await flush()
    expect(markAsReadAndDelivered).toHaveBeenCalledTimes(1)
  })

  it("holds later mail while the mailbox's card is unsent, and sends it as the next card", async () => {
    const { delivery, send, markAsDelivered, setCards, setUnread } = harness({
      unread: [mail('m2')]
    })
    setCards([mailCard(['m1'], { unsent: true })])
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    // Never added to the waiting card, and never a second card beside it.
    expect(send).not.toHaveBeenCalled()
    expect(markAsDelivered).not.toHaveBeenCalled()
    setCards([mailCard(['m1'], { accepted: true })])
    setUnread([mail('m2'), mail('m3')])
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].source.orchestration.messages.map((m) => m.messageId)).toEqual([
      'm2',
      'm3'
    ])
  })

  it('never sends mail a card already carries again, whatever became of the card', async () => {
    // A card queued just before Orca quit, its mail not yet marked: and the person deleted it.
    const { delivery, send, markAsDelivered, markAsReadAndDelivered, setCards } = harness({
      unread: [mail('m1'), mail('m2')]
    })
    setCards([mailCard(['m1'])])
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].source.orchestration.messages.map((m) => m.messageId)).toEqual([
      'm2'
    ])
    expect(markAsReadAndDelivered).toHaveBeenCalledWith(['m2'])
  })

  it('retains mail when the session is not attached', async () => {
    const { delivery, send } = harness({ attached: false })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('redrives a detached session when the journal replays on re-attach', async () => {
    // A transient detach parks nothing to be woken unless `session-not-attached` waits for the
    // journal edge, and the dispatch preamble tells the worker not to poll.
    const { delivery, send, setAttached, markAsReadAndDelivered } = harness({ attached: false })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()
    setAttached(true)
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(markAsReadAndDelivered).toHaveBeenCalledWith(['m1'])
  })

  it('nudges the worker while its coordinator holds an unacked Run delivery', async () => {
    // The exact window in which a coordinator replies to its workers: it checked, is acting on the
    // batch, and has not acked yet. The gate is keyed on the handle being nudged, so the
    // coordinator's `run:` delivery is invisible here — gating the WORKER's dispatch mailbox on it
    // dropped the nudge with nothing parked, and the worker sat idle on mail it was never told of.
    const { delivery, send, markAsReadAndDelivered } = harness({ outstandingRunDelivery: true })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(markAsReadAndDelivered).toHaveBeenCalledWith(['m1'])
  })

  it('does not re-nudge a mailbox still holding its own unacked batch', async () => {
    // The other half of the same gate: the consumer already has this batch, so a second nudge
    // spends a whole provider turn telling it something it was told.
    const { delivery, send } = harness({ outstandingOwnDelivery: true })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('retries a rejected nudge on the next journal edge, under the same id', async () => {
    // A rejection consumes no mail and nothing else redrives this mailbox, so leaving it unparked
    // stranded the worker until unrelated mail happened to arrive. The retry keeps the id: the host
    // replays a recorded refusal rather than starting the agent again.
    const { delivery, send, markAsReadAndDelivered } = harness({
      outcome: { kind: 'sent', state: 'rejected' }
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(markAsReadAndDelivered).not.toHaveBeenCalled()
    const first = send.mock.calls[0]![0].operationId
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]![0].operationId).toBe(first)
  })

  it('points again under a new id once a later send ran', async () => {
    const { delivery, send, setSubmissions } = harness({
      outcome: { kind: 'sent', state: 'unknown' }
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    const first = send.mock.calls[0]![0].operationId
    setSubmissions([
      { clientMessageId: first, dispatchState: 'unknown', submittedAt: Date.now() },
      { clientMessageId: 'user-turn', dispatchState: 'accepted', submittedAt: Date.now() + 1 }
    ])
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]![0].operationId).not.toBe(first)
  })

  it('points once more under a new id for a send an earlier process left in doubt', async () => {
    const { delivery, send, stored, setSubmissions } = harness({
      outcome: { kind: 'sent', state: 'unknown' }
    })
    stored.set('dispatch:d1', {
      mailbox_handle: 'dispatch:d1',
      session_id: 'session-1',
      operation_id: 'earlier-process-op',
      batch_fingerprint: structuredPointerBatchFingerprint('session-1', ['m1']),
      minted_at_ms: 0
    })
    setSubmissions([
      { clientMessageId: 'earlier-process-op', dispatchState: 'unknown', submittedAt: Date.now() }
    ])
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    const reminted = send.mock.calls[0]![0].operationId
    expect(reminted).not.toBe('earlier-process-op')
    // Minted by this process, the new id replays from here on.
    setSubmissions([
      { clientMessageId: 'earlier-process-op', dispatchState: 'unknown', submittedAt: Date.now() },
      { clientMessageId: reminted, dispatchState: 'unknown', submittedAt: Date.now() }
    ])
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send.mock.calls[1]![0].operationId).toBe(reminted)
  })

  it('keeps replaying its own send across a clock step, and re-mints only for a rewind that ran a turn', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { delivery, send, setSubmissions } = harness({
        outcome: { kind: 'sent', state: 'unknown' }
      })
      // The wall clock steps back an hour after the lane started: its own row is still its own.
      vi.setSystemTime(Date.now() - 60 * 60 * 1000)
      delivery.deliverForHandle('dispatch:d1')
      await flush()
      const first = send.mock.calls[0]![0].operationId
      setSubmissions([
        { clientMessageId: first, dispatchState: 'unknown', submittedAt: Date.now() }
      ])
      delivery.onJournalActivity('session-1')
      await flush()
      expect(send.mock.calls[1]![0].operationId).toBe(first)
      // A rewind dropped that send from the journal, and the person's turn ran after it.
      setSubmissions([
        { clientMessageId: 'user-turn', dispatchState: 'accepted', submittedAt: Date.now() + 1 }
      ])
      delivery.onJournalActivity('session-1')
      await flush()
      expect(send.mock.calls[2]![0].operationId).not.toBe(first)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not read a turn from before a backward clock step as one that ran after its pointer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { delivery, send, setSubmissions } = harness({
        outcome: { kind: 'sent', state: 'unknown' }
      })
      const personTurn = {
        clientMessageId: 'user-turn',
        dispatchState: 'accepted' as const,
        submittedAt: Date.now()
      }
      setSubmissions([personTurn])
      vi.setSystemTime(Date.now() - 2 * 60 * 1000)
      delivery.deliverForHandle('dispatch:d1')
      await flush()
      const first = send.mock.calls[0]![0].operationId
      setSubmissions([
        personTurn,
        { clientMessageId: first, dispatchState: 'unknown', submittedAt: Date.now() }
      ])
      for (let edge = 0; edge < 3; edge++) {
        delivery.onJournalActivity('session-1')
        await flush()
      }
      expect(send.mock.calls.map(([input]) => input.operationId)).toEqual([
        first,
        first,
        first,
        first
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads mail whose echo arrived after the lane stopped waiting, sending nothing more', async () => {
    const { delivery, send, markAsReadAndDelivered, stored, setSubmissions } = harness({
      outcome: { kind: 'sent', state: 'unknown' }
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    const first = send.mock.calls[0]![0].operationId
    setSubmissions([{ clientMessageId: first, dispatchState: 'pending', submittedAt: Date.now() }])
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    setSubmissions([{ clientMessageId: first, dispatchState: 'accepted', submittedAt: Date.now() }])
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(markAsReadAndDelivered).toHaveBeenCalledWith(['m1'])
    expect(stored.has('dispatch:d1')).toBe(false)
  })

  it('reuses one operation id for the same batch and re-mints when it grows', async () => {
    const { delivery, send, stored } = harness({ outcome: { kind: 'sent', state: 'unknown' } })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    const first = send.mock.calls[0]![0].operationId
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send.mock.calls[1]![0].operationId).toBe(first)
    stored.clear()
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send.mock.calls[2]![0].operationId).not.toBe(first)
  })
})

describe('forgetting one settled worker', () => {
  /** Two workers, each mid-turn and so each parked on its OWN session's journal edge. */
  /** Two workers, each detached and so each parked on its OWN session's journal edge. */
  function twoWorkerHarness() {
    let resolves = true
    let attached = false
    const sessionByMailbox: Record<string, string> = {
      'dispatch:d1': 'session-1',
      'dispatch:d2': 'session-2'
    }
    const send: StructuredMailboxPointerHost['send'] = vi.fn(async () => ({
      kind: 'sent' as const,
      state: 'accepted' as const
    }))
    const db = {
      getDispatchContextById: () => ({ run_id: 'run_1' }),
      hasOutstandingMailboxDelivery: () => false,
      getUndeliveredUnreadMessages: () => [mail('m1')],
      getMessageById: () => undefined,
      markAsReadAndDelivered: vi.fn(),
      getStructuredPointerOperation: () => undefined,
      putStructuredPointerOperation: () => {},
      deleteStructuredPointerOperation: () => {}
    }
    const delivery = new OrchestrationStructuredMailboxPointerDelivery({
      getDb: () => db as never,
      getMessageWaiters: () => undefined,
      resolveStructuredTarget: (mailboxHandle) => {
        const sessionId = sessionByMailbox[mailboxHandle]
        return resolves && sessionId
          ? { sessionId, dispatchId: mailboxHandle.slice('dispatch:'.length) }
          : null
      },
      getCliCommand: () => 'orca',
      host: {
        readFacts: async () => (attached ? { submissions: [], mailCards: [] } : null),
        readHandedOffMailCards: async () => [],
        currentFence: () => 4,
        send
      }
    })
    return {
      delivery,
      send: vi.mocked(send),
      goIdle: () => {
        attached = true
      },
      stopResolving: () => {
        resolves = false
      },
      resumeResolving: () => {
        resolves = true
      }
    }
  }

  it("keeps a sibling worker's wake-up edge when the target cannot be resolved", async () => {
    // The bug: `forgetSession` re-resolved every parked mailbox and pruned the ones that answered
    // null. A momentarily null DB reference or a session mid-teardown made that EVERY worker, so
    // the sibling's mail stayed durable but lost the edge that would have woken it.
    const { delivery, send, goIdle, stopResolving, resumeResolving } = twoWorkerHarness()
    delivery.deliverForHandle('dispatch:d1')
    delivery.deliverForHandle('dispatch:d2')
    await flush()
    expect(send).not.toHaveBeenCalled()

    stopResolving()
    delivery.forgetSession('session-1')
    resumeResolving()

    goIdle()
    delivery.onJournalActivity('session-2')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].sessionId).toBe('session-2')
  })

  it('still drops what the settled worker itself had parked', async () => {
    const { delivery, send, goIdle, stopResolving } = twoWorkerHarness()
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()

    // Settlement forgets the identity, so the target no longer resolves — which is exactly why
    // the recorded session id, not a re-resolution, has to be the test.
    stopResolving()
    delivery.forgetSession('session-1')

    goIdle()
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).not.toHaveBeenCalled()
  })
})
