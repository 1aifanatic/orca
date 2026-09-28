// The draft store's contract: exactly-once consume in one transaction, the
// returned transition following the journal's EFFECTIVE settlement, retention
// that never outruns a slow refusal, and rows that survive epoch replacement.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_HOST_RESTARTED
} from '../../../shared/structured-agent-session-dispatch-rejection'
import Database from '../../sqlite/sync-database'
import { journalDatabaseFile } from './journal-paths'
import { QUEUED_MESSAGE_REPLAY_WINDOW_MS } from './journal-queued-messages'
import { QueuedMessageNotConsumableError } from './journal-queued-messages'
import type { AgentSessionJournal } from './journal-store'
import { createTrackedJournalOpener } from './journal-store-test-open'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-q',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: { kind: 'claude', sessionId: 'native-1', leafUuid: null }
}

let root: string
let clock = 1_000

function tick(): number {
  clock += 1
  return clock
}

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

const journals = createTrackedJournalOpener()

async function open(): Promise<AgentSessionJournal> {
  const journal = await journals.open({
    identity: IDENTITY,
    journalDir: root,
    now: tick,
    mintEpoch: () => `epoch-${clock}`
  })
  return journal
}

async function queueDraft(journal: AgentSessionJournal, messageId: string, text = 'queued text') {
  return journal.queuedMessages.insert({
    messageId,
    body: message(text),
    fingerprint: `fp-${messageId}`,
    hostInstance: 'proc-1'
  })
}

async function consumeDraft(
  journal: AgentSessionJournal,
  messageId: string,
  options: { as?: string; expect?: 'waiting' | 'returned'; settledByOp?: string | null } = {}
) {
  const draft = journal.queuedMessages.get(messageId)
  await journal.appendSubmission(
    {
      clientMessageId: options.as ?? messageId,
      payloadFingerprint: draft?.fingerprint ?? `fp-${messageId}`,
      body: draft?.body ?? message('queued text'),
      fence: 0,
      handoverRecorded: true
    },
    {
      messageId,
      expect: options.expect ?? 'waiting',
      settledByOp: options.settledByOp ?? null
    }
  )
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-queued-message-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('draft rows', () => {
  it('creates the table at open without bumping user_version, so an old build stays writable', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await journal.close()
    const db = new Database(journalDatabaseFile(root), { readonly: true })
    try {
      const version = Number(db.pragma('user_version', { simple: true }))
      // An old build compares stored == supported and keeps writing; a bump
      // would latch it read-only after downgrade.
      expect(version).toBe(2)
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('queued_messages')
      expect(table).toBeDefined()
    } finally {
      db.close()
    }
  })

  it('opens a database an older build shaped (no drafts table) and creates the table', async () => {
    const first = await open()
    await first.appendItem(
      { provider: 'orca', clientMessageId: 'seed' },
      { kind: 'status', text: 'seed' },
      { fence: 0 }
    )
    await first.close()
    const db = new Database(journalDatabaseFile(root))
    db.exec('DROP TABLE queued_messages')
    db.close()
    const journal = await open()
    expect(journal.isReadOnly).toBe(false)
    const row = await queueDraft(journal, 'draft-1')
    expect(row.position).toBe(1)
  })

  it('assigns monotonic positions and lists in order', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await queueDraft(journal, 'draft-2')
    const listed = journal.queuedMessages.list()
    expect(listed.map((row) => [row.messageId, row.position, row.state])).toEqual([
      ['draft-1', 1, 'waiting'],
      ['draft-2', 2, 'waiting']
    ])
  })

  it('replays an insert under an already-used id instead of duplicating', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    const again = await queueDraft(journal, 'draft-1')
    expect(again.position).toBe(1)
    expect(journal.queuedMessages.list()).toHaveLength(1)
  })

  it('drafts survive epoch replacement, which deletes only journal rows', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await journal.replaceEpochItems('handle_forked', 0, [])
    expect(journal.queuedMessages.list().map((row) => row.messageId)).toEqual(['draft-1'])
  })
})

describe('consume', () => {
  it('converts waiting → dispatched and appends the submission in one transaction', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    const row = journal.queuedMessages.get('draft-1')
    expect(row?.state).toBe('dispatched')
    expect(row?.consumedAs).toBeNull()
    expect(journal.submissions().map((entry) => entry.clientMessageId)).toEqual(['draft-1'])
  })

  it('a second consume of the same draft fails and appends nothing (exactly-once)', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await expect(consumeDraft(journal, 'draft-1', { as: 'second-id' })).rejects.toBeInstanceOf(
      QueuedMessageNotConsumableError
    )
    expect(journal.submissions().map((entry) => entry.clientMessageId)).toEqual(['draft-1'])
  })

  it('a consume racing a withdraw loses and appends nothing', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await journal.queuedMessages.withdraw({
      messageIds: ['draft-1'],
      settledByOp: 'caller\u0000op-1'
    })
    await expect(consumeDraft(journal, 'draft-1')).rejects.toBeInstanceOf(
      QueuedMessageNotConsumableError
    )
    expect(journal.submissions()).toHaveLength(0)
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('withdrawn')
  })

  it('a failed submission insert rolls the draft transition back', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    const cursor = journal.cursor()
    // Occupy the next sequence directly so the append's INSERT violates the
    // primary key inside the transaction, after the draft was transitioned.
    const db = new Database(journalDatabaseFile(root))
    db.prepare(
      'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
    ).run(IDENTITY.sessionId, cursor.epoch, cursor.sequence + 1, tick(), '{}')
    db.close()
    await expect(consumeDraft(journal, 'draft-1')).rejects.toThrow()
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('waiting')
  })
})

describe('returned transition (D1/N4)', () => {
  it('a non-withdrawn rejection returns the consumed draft with its reason', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await journal.resolveDispatch({
      clientMessageId: 'draft-1',
      state: 'rejected',
      reason: 'Claude refused this payload',
      fence: 0
    })
    const row = journal.queuedMessages.get('draft-1')
    expect(row?.state).toBe('returned')
    expect(row?.returnedReason).toBe('Claude refused this payload')
  })

  it('a late rejection row after acceptance settles nothing and returns no card', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await journal.resolveDispatch({
      clientMessageId: 'draft-1',
      state: 'accepted',
      providerIdentity: { provider: 'claude', sessionId: 'native-1', uuid: 'echo-1' },
      fence: 0
    })
    await journal.resolveDispatch({
      clientMessageId: 'draft-1',
      state: 'rejected',
      reason: 'late duplicate',
      fence: 0
    })
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('dispatched')
  })

  it('a withdrawn (cancelled) rejection is not a refusal and returns no card', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await journal.resolveDispatch({
      clientMessageId: 'draft-1',
      state: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED,
      fence: 0
    })
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('dispatched')
  })

  it('refuse → Send under a fresh id → refuse again returns the card again; a late duplicate of the first refusal never touches the re-send (N4)', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await journal.resolveDispatch({
      clientMessageId: 'draft-1',
      state: 'rejected',
      reason: 'first refusal',
      fence: 0
    })
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('returned')
    // Send on the returned card re-consumes under a fresh submission id.
    await consumeDraft(journal, 'draft-1', { as: 'resend-1', expect: 'returned' })
    const resent = journal.queuedMessages.get('draft-1')
    expect(resent?.state).toBe('dispatched')
    expect(resent?.consumedAs).toBe('resend-1')
    // A duplicate resolution of the FIRST submission is ignored by the journal
    // and must not alter the draft's current relation.
    await journal.resolveDispatch({
      clientMessageId: 'draft-1',
      state: 'rejected',
      reason: 'duplicate of first refusal',
      fence: 0
    })
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('dispatched')
    // The re-send's own refusal returns the card, matched via consumed_as.
    await journal.resolveDispatch({
      clientMessageId: 'resend-1',
      state: 'rejected',
      reason: 'second refusal',
      fence: 0
    })
    const returned = journal.queuedMessages.get('draft-1')
    expect(returned?.state).toBe('returned')
    expect(returned?.returnedReason).toBe('second refusal')
  })

  it('a rejection never revives a withdrawn draft', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await journal.resolveDispatch({
      clientMessageId: 'draft-1',
      state: 'rejected',
      reason: 'refused',
      fence: 0
    })
    await journal.queuedMessages.withdraw({ messageIds: ['draft-1'], settledByOp: 'c\u0000op' })
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('withdrawn')
    await journal.resolveDispatch({
      clientMessageId: 'draft-1',
      state: 'rejected',
      reason: 'again',
      fence: 0
    })
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('withdrawn')
  })

  it('the returned row and its stored reason survive epoch replacement and reopen (B1)', async () => {
    let journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await journal.resolveDispatch({
      clientMessageId: 'draft-1',
      state: 'rejected',
      reason: 'stored refusal',
      fence: 0
    })
    await journal.replaceEpochItems('handle_forked', 0, [])
    await journal.close()
    journal = await open()
    const row = journal.queuedMessages.get('draft-1')
    expect(row?.state).toBe('returned')
    expect(row?.returnedReason).toBe('stored refusal')
  })
})

describe('withdraw', () => {
  it('withdraws waiting and returned rows together and hands their bodies back as receipts', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1', 'first text')
    await queueDraft(journal, 'draft-2', 'second text')
    await consumeDraft(journal, 'draft-1')
    await journal.resolveDispatch({
      clientMessageId: 'draft-1',
      state: 'rejected',
      reason: 'refused',
      fence: 0
    })
    const withdrawn = await journal.queuedMessages.withdraw({
      messageIds: ['draft-1', 'draft-2'],
      settledByOp: 'caller\u0000stop-1'
    })
    expect(withdrawn.map((row) => [row.messageId, row.body.blocks])).toEqual([
      ['draft-1', [{ type: 'text', text: 'first text' }]],
      ['draft-2', [{ type: 'text', text: 'second text' }]]
    ])
    // A lost acknowledgement replays from the tombstones, keyed by the
    // caller-scoped operation key — never from the ledger.
    const receipts = journal.queuedMessages.receipts('caller\u0000stop-1')
    expect(receipts.map((row) => row.messageId)).toEqual(['draft-1', 'draft-2'])
    // Pending or dispatched rows stay outside the withdrawable set.
    const second = await journal.queuedMessages.withdraw({
      messageIds: ['draft-1'],
      settledByOp: 'caller\u0000stop-2'
    })
    expect(second).toHaveLength(0)
  })

  it('two callers reusing one operation id read only their own receipts', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await journal.queuedMessages.withdraw({
      messageIds: ['draft-1'],
      settledByOp: 'caller-a\u0000op-1'
    })
    expect(journal.queuedMessages.receipts('caller-b\u0000op-1')).toHaveLength(0)
    expect(journal.queuedMessages.receipts('caller-a\u0000op-1')).toHaveLength(1)
  })
})

describe('open-time repair and retention', () => {
  it('returns a dispatched row whose loaded submission is effectively rejected (downgrade wrote no hook)', async () => {
    let journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await journal.resolveDispatch({
      clientMessageId: 'draft-1',
      state: 'rejected',
      reason: 'refused while downgraded',
      fence: 0
    })
    await journal.close()
    // Simulate the old build having written the rejection with no hook: put the
    // draft back to dispatched behind the stored fact.
    const db = new Database(journalDatabaseFile(root))
    db.prepare(
      "UPDATE queued_messages SET state = 'dispatched', returned_reason = NULL WHERE message_id = ?"
    ).run('draft-1')
    db.close()
    journal = await open()
    const row = journal.queuedMessages.get('draft-1')
    expect(row?.state).toBe('returned')
    expect(row?.returnedReason).toBe('refused while downgraded')
  })

  it('keeps a dispatched row while its submission is still pending, even past the window, so a late refusal still returns it (N5)', async () => {
    let journal = await open()
    await queueDraft(journal, 'draft-1')
    await consumeDraft(journal, 'draft-1')
    await journal.close()
    // Reopen "25 hours" later: the submission is still queued/pending.
    clock += QUEUED_MESSAGE_REPLAY_WINDOW_MS + 60 * 60 * 1000
    journal = await open()
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('dispatched')
    // The delivery loop's leftover rejection now returns the card.
    await journal.rejectQueuedSubmissions(0, DISPATCH_REJECTED_HOST_RESTARTED)
    const row = journal.queuedMessages.get('draft-1')
    expect(row?.state).toBe('returned')
    expect(row?.returnedReason).toBe(DISPATCH_REJECTED_HOST_RESTARTED)
  })

  it('prunes accepted and withdrawn rows once the replay window passes, and never waiting or returned rows', async () => {
    let journal = await open()
    await queueDraft(journal, 'accepted-1')
    await consumeDraft(journal, 'accepted-1')
    await journal.resolveDispatch({
      clientMessageId: 'accepted-1',
      state: 'accepted',
      providerIdentity: { provider: 'claude', sessionId: 'native-1', uuid: 'echo-1' },
      fence: 0
    })
    await queueDraft(journal, 'withdrawn-1')
    await journal.queuedMessages.withdraw({
      messageIds: ['withdrawn-1'],
      settledByOp: 'c\u0000op-w'
    })
    await queueDraft(journal, 'waiting-1')
    await queueDraft(journal, 'returned-1')
    await consumeDraft(journal, 'returned-1')
    await journal.resolveDispatch({
      clientMessageId: 'returned-1',
      state: 'rejected',
      reason: 'refused',
      fence: 0
    })
    await journal.close()
    clock += QUEUED_MESSAGE_REPLAY_WINDOW_MS + 1_000
    journal = await open()
    expect(journal.queuedMessages.list().map((row) => [row.messageId, row.state])).toEqual([
      ['waiting-1', 'waiting'],
      ['returned-1', 'returned']
    ])
  })

  it('keeps fresh tombstones inside the replay window', async () => {
    let journal = await open()
    await queueDraft(journal, 'withdrawn-1')
    await journal.queuedMessages.withdraw({
      messageIds: ['withdrawn-1'],
      settledByOp: 'c\u0000op-w'
    })
    await journal.close()
    clock += 1_000
    journal = await open()
    expect(journal.queuedMessages.get('withdrawn-1')?.state).toBe('withdrawn')
  })
})
