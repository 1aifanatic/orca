import { describe, expect, it, vi } from 'vitest'
import {
  OrchestrationStructuredMailboxPointerDelivery,
  type StructuredMailboxPointerHost,
  type StructuredPointerSendOutcome
} from './structured-mailbox-pointer-delivery'
import type { StructuredPointerOperationRow } from './db/messages/structured-pointer-operation-store'
import { structuredPointerBatchFingerprint } from './structured-pointer-operation-id'
import type {
  StructuredPointerCard,
  StructuredPointerFacts
} from './structured-pointer-notice-cards'
import type { StructuredWorkerIdentity } from '../structured-worker-identity'
import type { PointerBatchMessage } from './structured-pointer-source'

const IDENTITY: StructuredWorkerIdentity = {
  handle: 'structworker_1',
  sessionId: 'session-1',
  agent: 'claude',
  paneKey: 'structured-agent-session-session-1:11111111-1111-4111-a111-111111111111',
  processIncarnation: 'structured:session-1',
  worktreeId: 'wt_1',
  hostScope: { kind: 'local', hostId: 'local' }
}

type Unread = PointerBatchMessage

function mail(id: string, sequence: number, from = 'term_peer'): Unread {
  return { id, type: 'status', sequence, from_handle: from, run_id: 'run_1' }
}

type Submission = StructuredPointerFacts['submissions'][number]

/** A mail notice for `dispatch:d1` in the chat's queue, as the host reports it. */
function noticeCard(
  messageId: string,
  state: StructuredPointerCard['state'],
  options: { messageIds?: string[]; withdrawnByRequest?: boolean; mailbox?: string } = {}
): StructuredPointerCard {
  return {
    messageId,
    state,
    notice: { mailbox: options.mailbox ?? 'dispatch:d1', messageIds: options.messageIds ?? ['m1'] },
    withdrawnByRequest: options.withdrawnByRequest ?? false
  }
}

function harness(options: {
  /** False: the host cannot read the session (not attached on this runtime). */
  attached?: boolean
  dispatchState?: 'accepted' | 'rejected' | 'unknown'
  /** The chat is busy: the host holds the pointer as a card in its queue. */
  busy?: boolean
  /** The coordinator of this worker's Run is mid-batch: it checked and has not acked yet. */
  outstandingRunDelivery?: boolean
  outstandingOwnDelivery?: boolean
  /** The mailbox this worker owns; its own handle for direct peer mail outside a dispatch. */
  mailbox?: string
  dispatchId?: string | null
}) {
  const mailbox = options.mailbox ?? 'dispatch:d1'
  const dispatchId = options.dispatchId === undefined ? 'd1' : options.dispatchId
  let attached = options.attached ?? true
  let unread: Unread[] = [mail('m1', 3)]
  let targetSession: string | null = IDENTITY.sessionId
  let outstanding = options.outstandingOwnDelivery ?? false
  let hostUp = true
  // The session's recorded sends and queue cards, as its journal reports them.
  let submissions: Submission[] = []
  let cards: StructuredPointerCard[] = []
  const markAsDelivered = vi.fn()
  const send = vi.fn(
    async (
      input: Parameters<StructuredMailboxPointerHost['send']>[0]
    ): Promise<StructuredPointerSendOutcome> => {
      if (options.busy) {
        // What the host does with a `queue` send to a busy chat: a card under the send's own id.
        const { mailbox: queuedFor, messageIds } = input.source.orchestration
        cards = [
          ...cards,
          noticeCard(input.operationId, 'waiting', {
            mailbox: queuedFor,
            messageIds: [...messageIds]
          })
        ]
        return { kind: 'queued', state: 'waiting' }
      }
      return { kind: 'sent', state: options.dispatchState ?? 'accepted' }
    }
  )
  const onRetain = vi.fn()
  const stored = new Map<string, StructuredPointerOperationRow>()
  const db = {
    getDispatchContextById: () => ({ run_id: 'run_1' }),
    hasOutstandingMailboxDelivery: (handle: string) =>
      ((options.outstandingRunDelivery ?? false) && handle.startsWith('run:')) ||
      (outstanding && !handle.startsWith('run:')),
    getUndeliveredUnreadMessages: () => unread,
    markAsDelivered,
    getStructuredPointerOperation: (key: string) => stored.get(key),
    putStructuredPointerOperation: (row: StructuredPointerOperationRow) =>
      stored.set(row.mailbox_handle, row),
    deleteStructuredPointerOperation: (key: string) => stored.delete(key),
    deleteStructuredPointerOperationsForSession: (sessionId: string) => {
      for (const [key, row] of stored) {
        if (row.session_id === sessionId) {
          stored.delete(key)
        }
      }
    }
  }
  const host: StructuredMailboxPointerHost = {
    readFacts: async () => (attached ? { submissions, cards } : null),
    currentFence: () => (hostUp ? 4 : null),
    send
  }
  const delivery = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db as never,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: (mailboxHandle) =>
      mailboxHandle === mailbox && targetSession ? { sessionId: targetSession, dispatchId } : null,
    getCliCommand: () => 'orca-dev',
    host,
    onRetain
  })
  return {
    delivery,
    markAsDelivered,
    send,
    onRetain,
    stored,
    /** The agent opened its mail with `check` and has not acked it. */
    openBatch: () => {
      outstanding = true
    },
    /** Orca is quitting: no host is left to resolve a session's mail through. */
    stopHost: () => {
      hostUp = false
    },
    /** A /clear moves the mailbox to the successor; settling the worker (abandon) to none. */
    moveTarget: (sessionId: string | null) => {
      targetSession = sessionId
    },
    attach: () => {
      attached = true
    },
    setUnread: (next: Unread[]) => {
      unread = next
    },
    setSubmissions: (next: Submission[]) => {
      submissions = next
    },
    setCards: (next: StructuredPointerCard[]) => {
      cards = next
    },
    cards: () => cards
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('structured mailbox pointer delivery', () => {
  it('claims only mailboxes whose assignee is a structured worker', () => {
    const { delivery } = harness({})
    expect(delivery.deliverForHandle('dispatch:d1')).toBe(true)
    expect(delivery.deliverForHandle('run:run_1')).toBe(false)
  })

  it('sends the pointer as a turn and consumes mail on an accepted dispatch', async () => {
    const { delivery, markAsDelivered, send } = harness({})
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].operationId).toMatch(/^\d{13}-[0-9a-f]{32}$/)
    expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
  })

  it('nudges through the worker`s own handle for direct peer mail outside a dispatch', async () => {
    const { delivery, send, markAsDelivered } = harness({
      mailbox: IDENTITY.handle,
      dispatchId: null
    })
    expect(delivery.deliverForHandle(IDENTITY.handle)).toBe(true)
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].dispatchId).toBeNull()
    // A plain `check`, with no `--run`: the worker resolves its OWN mailbox by identity, and for a
    // worker outside a dispatch that is the direct mailbox this mail is sitting in. Pointing it at
    // a run would send it to read a coordinator mailbox that has nothing waiting.
    expect(send.mock.calls[0]![0].body.blocks[0]).toMatchObject({
      text: expect.not.stringContaining('--run')
    })
    expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
  })

  it('retains mail when the dispatch settles unknown', async () => {
    const { delivery, markAsDelivered } = harness({
      dispatchState: 'unknown'
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(markAsDelivered).not.toHaveBeenCalled()
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
    const { delivery, send, attach, markAsDelivered } = harness({ attached: false })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()
    attach()
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
  })

  it('nudges the worker while its coordinator holds an unacked Run delivery', async () => {
    // The exact window in which a coordinator replies to its workers: it checked, is acting on the
    // batch, and has not acked yet. The gate is keyed on the handle being nudged, so the
    // coordinator's `run:` delivery is invisible here — gating the WORKER's dispatch mailbox on it
    // dropped the nudge with nothing parked, and the worker sat idle on mail it was never told of.
    const { delivery, send, markAsDelivered } = harness({
      outstandingRunDelivery: true
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
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
    const { delivery, send, markAsDelivered } = harness({
      dispatchState: 'rejected'
    })
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(markAsDelivered).not.toHaveBeenCalled()
    const first = send.mock.calls[0]![0].operationId
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]![0].operationId).toBe(first)
  })

  it('points again under a new id once a later send ran', async () => {
    const { delivery, send, setSubmissions } = harness({
      dispatchState: 'unknown'
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
      dispatchState: 'unknown'
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
        dispatchState: 'unknown'
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
        dispatchState: 'unknown'
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

  it('stamps a pointer whose echo arrived after the lane stopped waiting, sending nothing more', async () => {
    const { delivery, send, markAsDelivered, stored, setSubmissions } = harness({
      dispatchState: 'unknown'
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
    expect(markAsDelivered).toHaveBeenCalledWith(['m1'])
    expect(stored.has('dispatch:d1')).toBe(false)
  })

  it('reuses one operation id for the same batch and re-mints when it grows', async () => {
    const { delivery, send, stored } = harness({
      dispatchState: 'unknown'
    })
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

describe("a pointer to a busy chat waits in the chat's own queue", () => {
  const SECOND: Unread = mail('m2', 4, 'term_other')

  async function queuedCard(h: ReturnType<typeof harness>): Promise<string> {
    h.delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(h.send).toHaveBeenCalledTimes(1)
    return h.send.mock.calls[0]![0].operationId
  }

  function handedOff(card: string, dispatchState: Submission['dispatchState']): Submission {
    return {
      clientMessageId: 'queue-hand-off',
      queuedMessageId: card,
      dispatchState,
      submittedAt: Date.now() + 1
    }
  }

  it('is sent once, by the queue, and consumes mail only when that hand-off is accepted', async () => {
    const h = harness({ busy: true })
    const card = await queuedCard(h)
    expect(h.onRetain).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'queued' }))
    expect(h.markAsDelivered).not.toHaveBeenCalled()
    // The card carries the send from here: no row keeps a second record of it.
    expect(h.stored.size).toBe(0)
    h.delivery.onJournalActivity('session-1')
    await flush()
    expect(h.send).toHaveBeenCalledTimes(1)
    // The queue sends it when the turn ends, under a fresh id that names the card.
    h.setCards([noticeCard(card, 'dispatched')])
    h.setSubmissions([handedOff(card, 'pending')])
    h.delivery.onJournalActivity('session-1')
    await flush()
    expect(h.markAsDelivered).not.toHaveBeenCalled()
    h.setSubmissions([handedOff(card, 'accepted')])
    h.delivery.onJournalActivity('session-1')
    await flush()
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.markAsDelivered).toHaveBeenCalledWith(['m1'])
  })

  it('stamps the mail the card counted when it was sent, as the queue restated it', async () => {
    const h = harness({ busy: true })
    const card = await queuedCard(h)
    h.setUnread([mail('m1', 3), SECOND])
    h.setCards([noticeCard(card, 'dispatched', { messageIds: ['m1', 'm2'] })])
    h.setSubmissions([handedOff(card, 'accepted')])
    h.delivery.onJournalActivity('session-1')
    await flush()
    expect(h.markAsDelivered).toHaveBeenCalledWith(['m1', 'm2'])
    expect(h.send).toHaveBeenCalledTimes(1)
  })

  it('keeps its one card when more mail arrives: the queue restates it as it sends', async () => {
    const h = harness({ busy: true })
    const card = await queuedCard(h)
    h.setUnread([mail('m1', 3), SECOND])
    h.delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.cards()).toEqual([noticeCard(card, 'waiting')])
    expect(h.onRetain).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'queued' }))
  })

  it('finds a card no row names, by what it is: queued by an earlier process, or carried by /clear', async () => {
    const h = harness({ busy: true })
    // The row still names the conversation /clear replaced; the card moved under the same id.
    h.stored.set('dispatch:d1', {
      mailbox_handle: 'dispatch:d1',
      session_id: 'session-0',
      operation_id: 'carried-card',
      batch_fingerprint: structuredPointerBatchFingerprint('session-0', ['m1']),
      minted_at_ms: 0
    })
    h.setCards([noticeCard('carried-card', 'waiting')])
    h.delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.stored.size).toBe(0)
    expect(h.onRetain).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'queued' }))
    // Its hand-off in the new conversation is what stamps the mail.
    h.setCards([noticeCard('carried-card', 'dispatched')])
    h.setSubmissions([handedOff('carried-card', 'accepted')])
    h.delivery.onJournalActivity('session-1')
    await flush()
    expect(h.markAsDelivered).toHaveBeenCalledWith(['m1'])
    expect(h.send).not.toHaveBeenCalled()
  })

  it("ignores another mailbox's card", async () => {
    const h = harness({ busy: true })
    h.setCards([noticeCard('other-card', 'waiting', { mailbox: 'run:run_1' })])
    h.delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(h.send).toHaveBeenCalledTimes(1)
  })

  it("counts a card an operation deleted (a labelled card's Delete, from B) as handled: that mail is not pointed again, newer mail is", async () => {
    const h = harness({ busy: true })
    const card = await queuedCard(h)
    h.setCards([noticeCard(card, 'withdrawn', { withdrawnByRequest: true })])
    // The person talked to the agent since, which alone would otherwise re-point the batch.
    h.setSubmissions([
      { clientMessageId: 'user-turn', dispatchState: 'accepted', submittedAt: Date.now() + 1 }
    ])
    h.delivery.onJournalActivity('session-1')
    await flush()
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.markAsDelivered).toHaveBeenCalledWith(['m1'])
    h.setUnread([SECOND])
    h.delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(h.send).toHaveBeenCalledTimes(2)
  })

  it('reads a card the host withdrew (its mail was gone, or /clear moved it) as no decline', async () => {
    const h = harness({ busy: true })
    const card = await queuedCard(h)
    h.setCards([noticeCard(card, 'withdrawn')])
    h.delivery.onJournalActivity('session-1')
    await flush()
    expect(h.markAsDelivered).not.toHaveBeenCalled()
    // The mail is still owed, so it is pointed again.
    expect(h.send).toHaveBeenCalledTimes(2)
  })

  it('stamps the mail an accepted hand-off carried even when the agent already opened it', async () => {
    const h = harness({ busy: true })
    const card = await queuedCard(h)
    h.setCards([noticeCard(card, 'dispatched')])
    h.setSubmissions([handedOff(card, 'accepted')])
    h.openBatch()
    h.delivery.onJournalActivity('session-1')
    await flush()
    expect(h.markAsDelivered).toHaveBeenCalledWith(['m1'])
    expect(h.send).toHaveBeenCalledTimes(1)
  })

  it('waits on a card the provider refused (the host withdrew it) until a later turn ran', async () => {
    const h = harness({ busy: true })
    const card = await queuedCard(h)
    h.setCards([noticeCard(card, 'withdrawn')])
    h.setSubmissions([handedOff(card, 'rejected')])
    h.delivery.onJournalActivity('session-1')
    await flush()
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.onRetain).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: 'dispatch-rejected' })
    )
    h.setSubmissions([
      handedOff(card, 'rejected'),
      { clientMessageId: 'user-turn', dispatchState: 'accepted', submittedAt: Date.now() + 5 }
    ])
    h.delivery.onJournalActivity('session-1')
    await flush()
    expect(h.send).toHaveBeenCalledTimes(2)
  })

  it('points a refused or stopped card again at once when newer mail makes it a different notice', async () => {
    const h = harness({ busy: true })
    const card = await queuedCard(h)
    h.setCards([noticeCard(card, 'withdrawn')])
    h.setSubmissions([handedOff(card, 'rejected')])
    h.setUnread([mail('m1', 3), SECOND])
    h.delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(h.send).toHaveBeenCalledTimes(2)
    expect(h.send.mock.calls[1]![0].source.orchestration.messageIds).toEqual(['m1', 'm2'])
  })

  it('waits on a hand-off of unknown fate until a later turn shows it did not land', async () => {
    const h = harness({ busy: true })
    const card = await queuedCard(h)
    h.setCards([noticeCard(card, 'dispatched')])
    h.setSubmissions([handedOff(card, 'unknown')])
    h.delivery.onJournalActivity('session-1')
    await flush()
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.onRetain).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: 'dispatch-unknown' })
    )
    h.setSubmissions([
      handedOff(card, 'unknown'),
      { clientMessageId: 'user-turn', dispatchState: 'accepted', submittedAt: Date.now() + 5 }
    ])
    h.delivery.onJournalActivity('session-1')
    await flush()
    expect(h.send).toHaveBeenCalledTimes(2)
  })
})

describe('the queue judges a notice again as it sends', () => {
  const SOURCE = {
    kind: 'agent' as const,
    senders: [],
    orchestration: {
      message: 'mail-notice' as const,
      mailbox: 'dispatch:d1',
      dispatchId: 'd1',
      runIds: ['run_1'],
      messageIds: ['m1']
    }
  }

  it('sends a notice that still counts exactly the mail owed', () => {
    const h = harness({})
    expect(h.delivery.judgeQueuedCard({ sessionId: 'session-1', source: SOURCE })).toEqual({
      kind: 'send'
    })
  })

  it('withdraws a notice whose mail was read, or that a consumer or waiter now holds', () => {
    const h = harness({})
    h.setUnread([])
    expect(h.delivery.judgeQueuedCard({ sessionId: 'session-1', source: SOURCE })).toEqual({
      kind: 'withdraw'
    })
    const held = harness({ outstandingOwnDelivery: true })
    expect(held.delivery.judgeQueuedCard({ sessionId: 'session-1', source: SOURCE })).toEqual({
      kind: 'withdraw'
    })
  })

  it('restates the count and the senders from the mail owed now', () => {
    const h = harness({})
    h.setUnread([mail('m2', 4, 'term_other'), mail('m3', 5, 'term_other')])
    const verdict = h.delivery.judgeQueuedCard({ sessionId: 'session-1', source: SOURCE })
    expect(verdict).toMatchObject({
      kind: 'restate',
      body: {
        blocks: [
          { type: 'text', text: expect.stringContaining('You have 2 orchestration messages') }
        ]
      },
      source: {
        kind: 'agent',
        senders: [
          {
            party: {
              address: 'term_other',
              terminalHandle: 'term_other',
              orcaSessionId: null
            }
          }
        ],
        orchestration: {
          message: 'mail-notice',
          mailbox: 'dispatch:d1',
          dispatchId: 'd1',
          runIds: ['run_1'],
          messageIds: ['m2', 'm3']
        }
      }
    })
  })

  it('withdraws a notice for a dispatch whose worker was released (abandoned), mail still unread', () => {
    const h = harness({})
    h.moveTarget(null)
    expect(h.delivery.judgeQueuedCard({ sessionId: 'session-1', source: SOURCE })).toEqual({
      kind: 'withdraw'
    })
  })

  it('decides nothing while no host can resolve the mailbox (Orca quitting): the card waits', () => {
    const h = harness({})
    h.stopHost()
    expect(h.delivery.judgeQueuedCard({ sessionId: 'session-1', source: SOURCE })).toEqual({
      kind: 'defer'
    })
  })

  it('withdraws a notice in a session the mailbox no longer reaches', () => {
    const h = harness({})
    h.moveTarget('session-2')
    expect(h.delivery.judgeQueuedCard({ sessionId: 'session-1', source: SOURCE })).toEqual({
      kind: 'withdraw'
    })
  })
})

describe('forgetting one settled worker', () => {
  /** Two workers, each not yet attached and so each parked on its OWN session's journal edge. */
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
      getUndeliveredUnreadMessages: () => [mail('m1', 3)],
      markAsDelivered: vi.fn(),
      getStructuredPointerOperation: () => undefined,
      putStructuredPointerOperation: () => {},
      deleteStructuredPointerOperation: () => {},
      deleteStructuredPointerOperationsForSession: () => {}
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
        readFacts: async () => (attached ? { submissions: [], cards: [] } : null),
        currentFence: () => 4,
        send
      }
    })
    return {
      delivery,
      send: vi.mocked(send),
      attach: () => {
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
    const { delivery, send, attach, stopResolving, resumeResolving } = twoWorkerHarness()
    delivery.deliverForHandle('dispatch:d1')
    delivery.deliverForHandle('dispatch:d2')
    await flush()
    expect(send).not.toHaveBeenCalled()

    stopResolving()
    delivery.forgetSession('session-1')
    resumeResolving()

    attach()
    delivery.onJournalActivity('session-2')
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].sessionId).toBe('session-2')
  })

  it('still drops what the settled worker itself had parked', async () => {
    const { delivery, send, attach, stopResolving } = twoWorkerHarness()
    delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(send).not.toHaveBeenCalled()

    // Settlement forgets the identity, so the target no longer resolves — which is exactly why
    // the recorded session id, not a re-resolution, has to be the test.
    stopResolving()
    delivery.forgetSession('session-1')

    attach()
    delivery.onJournalActivity('session-1')
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it("deletes the settled worker's pointer rows, which nothing reconciles again", async () => {
    const h = harness({ dispatchState: 'unknown' })
    h.delivery.deliverForHandle('dispatch:d1')
    await flush()
    expect(h.stored.size).toBe(1)
    h.delivery.forgetSession('session-1')
    expect(h.stored.size).toBe(0)
  })
})
