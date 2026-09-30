// The queue's pause is a pure function of the journal: a Stop and a Resume are rows, a person's
// accepted turn is a row, and a /clear's carried card names its source. Nothing is stored beside
// them, so nothing has to retire.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import Database from '../../sqlite/sync-database'
import { journalDatabasePath } from './journal-host-database'
import {
  createTrackedJournalOpener,
  liveTestJournalRows
} from './journal-host-database-test-support'
import { QueuedMessageNotConsumableError } from './journal-queued-messages'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { parseJournalRow } from './journal-row-schema'
import type { AgentSessionJournal } from './journal-store'
import { queuePauseHolds } from './queued-message-pause'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-p',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: { kind: 'claude', sessionId: 'native-1', leafUuid: null }
}
const HOST = 'proc-1'

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function open(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: () => ++clock,
    mintEpoch: () => `epoch-${clock}`
  })
}

function queueDraft(journal: AgentSessionJournal, messageId: string, carriedFrom?: string) {
  return journal.queuedMessages.insert({
    messageId,
    body: message(messageId),
    fingerprint: `fp-${messageId}`,
    hostInstance: HOST,
    ...(carriedFrom ? { carriedFrom } : {})
  })
}

/** A turn sent, then accepted by the provider; `origin` says who asked for it. */
async function turn(
  journal: AgentSessionJournal,
  id: string,
  origin: 'client' | 'host',
  accept = true
): Promise<void> {
  await journal.appendSubmission({
    clientMessageId: id,
    origin,
    payloadFingerprint: `fp-${id}`,
    body: message(id),
    fence: 0,
    handoverRecorded: true
  })
  if (accept) {
    await acceptTurn(journal, id)
  }
}

function acceptTurn(journal: AgentSessionJournal, id: string) {
  return journal.resolveDispatch({
    clientMessageId: id,
    state: 'accepted',
    providerIdentity: { provider: 'claude', sessionId: 'native-1', uuid: `echo-${id}` },
    fence: 0
  })
}

function reason(journal: AgentSessionJournal): string | null {
  return journal.queuedMessages.pause(HOST)?.reason ?? null
}

/** Each card, and whether the queue's pause holds it. */
function held(journal: AgentSessionJournal): [string, boolean][] {
  const pause = journal.queuedMessages.pause(HOST)
  return journal.queuedMessages
    .list()
    .filter((card) => card.state === 'waiting')
    .map((card) => [card.messageId, pause !== null && queuePauseHolds(pause, card)])
}

function storedPauses(): number {
  const db = new Database(journalDatabasePath(root), { readonly: true })
  try {
    const row: unknown = db.prepare('SELECT COUNT(*) AS n FROM queued_message_pauses').get()
    return typeof row === 'object' && row !== null && 'n' in row ? Number(row.n) : -1
  } finally {
    db.close()
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-queue-pause-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe("the queue's pause, derived from the journal", () => {
  it('a Stop row pauses the queue, even with no card yet, survives reopen, and stores nothing', async () => {
    let journal = await open()
    await journal.appendQueuePauseMark('stopped', 0)
    expect(reason(journal)).toBe('stopped')
    await queueDraft(journal, 'draft-1')
    await journal.close()
    journal = await open()
    expect(reason(journal)).toBe('stopped')
    expect(storedPauses()).toBe(0)
  })

  it("only a person's turn sent after the Stop and accepted lifts it; host turns never do", async () => {
    const journal = await open()
    await turn(journal, 'before-stop', 'client', false)
    await journal.appendQueuePauseMark('stopped', 0)
    // Sent before the Stop: its acceptance now does not end a Stop that came after it.
    await acceptTurn(journal, 'before-stop')
    await turn(journal, 'mail', 'host')
    expect(reason(journal)).toBe('stopped')
    await turn(journal, 'typed', 'client', false)
    expect(reason(journal)).toBe('stopped')
    await acceptTurn(journal, 'typed')
    expect(reason(journal)).toBeNull()
  })

  it('a later Stop is the latest, and a Resume row lifts it', async () => {
    const journal = await open()
    await journal.appendQueuePauseMark('stopped', 0)
    await turn(journal, 'typed', 'client')
    expect(reason(journal)).toBeNull()
    await journal.appendQueuePauseMark('stopped', 0)
    expect(reason(journal)).toBe('stopped')
    await journal.appendQueuePauseMark('resumed', 0)
    expect(reason(journal)).toBeNull()
    await journal.appendQueuePauseMark('stopped', 0)
    expect(reason(journal)).toBe('stopped')
    expect(storedPauses()).toBe(0)
  })

  it("a card /clear carried in pauses the replacement 'cleared' until a Resume there", async () => {
    let journal = await open()
    await queueDraft(journal, 'carried', 'source-session')
    expect(reason(journal)).toBe('cleared')
    await journal.close()
    journal = await open()
    expect(reason(journal)).toBe('cleared')
    await journal.appendQueuePauseMark('resumed', 0)
    expect(reason(journal)).toBeNull()
    expect(storedPauses()).toBe(0)
  })

  it("a person's accepted turn on the replacement lifts 'cleared'; a host turn does not", async () => {
    const journal = await open()
    await queueDraft(journal, 'carried', 'source-session')
    await turn(journal, 'launch', 'host')
    expect(reason(journal)).toBe('cleared')
    await turn(journal, 'typed', 'client')
    expect(reason(journal)).toBeNull()
  })

  it('rides a tombstone of an id no item takes, so an older build reads it and changes nothing', async () => {
    const journal = await open()
    await turn(journal, 'typed', 'client')
    await journal.appendQueuePauseMark('stopped', 0)
    const db = new Database(journalDatabasePath(root), { readonly: true })
    const stored = liveTestJournalRows(db, IDENTITY.sessionId)
    db.close()
    const parsed = parseJournalRow(stored.at(-1)?.rowJson ?? '')
    expect(parsed).toMatchObject({ ok: true, row: { kind: 'tombstone', queuePause: 'stopped' } })
    if (!parsed.ok || parsed.row.kind !== 'tombstone') {
      throw new Error('expected a tombstone row')
    }
    // An older build ignores the unknown key: the row is an ordinary removal of nothing.
    const { queuePause: _ignored, ...asOlderBuildReadsIt } = parsed.row
    const state = createJournalReducerState(IDENTITY.sessionId, parsed.row.epoch)
    for (const row of stored.slice(0, -1)) {
      const earlier = parseJournalRow(row.rowJson)
      if (earlier.ok) {
        applyJournalRow(state, earlier.row)
      }
    }
    const items = [...state.items.keys()]
    const submissions = [...state.submissions.keys()]
    applyJournalRow(state, asOlderBuildReadsIt)
    expect([...state.items.keys()]).toEqual(items)
    expect([...state.submissions.keys()]).toEqual(submissions)
  })

  it("the queue's own consume is refused in its transaction while the pause holds the card; Send-now is not", async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    await journal.appendQueuePauseMark('stopped', 0)
    const consume = (id: string, automatic: boolean) =>
      journal.appendSubmission(
        {
          clientMessageId: id,
          origin: automatic ? 'host' : 'client',
          payloadFingerprint: 'fp-draft-1',
          body: message('draft-1'),
          fence: 0,
          handoverRecorded: true
        },
        {
          messageId: 'draft-1',
          expect: 'waiting',
          settledByOp: null,
          hostInstance: HOST,
          ...(automatic ? { yieldsToPause: { hostInstance: HOST } } : {})
        }
      )
    await expect(consume('drain-1', true)).rejects.toBeInstanceOf(QueuedMessageNotConsumableError)
    expect(journal.submission('drain-1')).toBeUndefined()
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('waiting')
    await consume('send-now-1', false)
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('dispatched')
  })

  it("a rewind's epoch replacement restates a Stop still pausing, and not one a person ended", async () => {
    const journal = await open()
    await journal.appendQueuePauseMark('stopped', 0)
    await journal.replaceEpochItems('handle_forked', 0, [])
    expect(reason(journal)).toBe('stopped')
    await turn(journal, 'typed', 'client')
    await journal.replaceEpochItems('handle_forked', 0, [])
    expect(reason(journal)).toBeNull()
  })
})

describe('which cards a pause holds', () => {
  it('only cards queued before the Stop row: one queued after it is a new instruction', async () => {
    let journal = await open()
    await queueDraft(journal, 'before')
    await journal.appendQueuePauseMark('stopped', 0)
    await queueDraft(journal, 'after')
    expect(held(journal)).toEqual([
      ['before', true],
      ['after', false]
    ])
    await journal.close()
    journal = await open()
    expect(held(journal)).toEqual([
      ['before', true],
      ['after', false]
    ])
  })

  it('a steer the Stop withdrew comes back in its own place, and is held', async () => {
    const journal = await open()
    await queueDraft(journal, 'steered')
    await journal.appendSubmission(
      {
        clientMessageId: 'send-now-1',
        origin: 'client',
        payloadFingerprint: 'fp-steered',
        body: message('steered'),
        fence: 0,
        handoverRecorded: true
      },
      { messageId: 'steered', expect: 'waiting', settledByOp: null, hostInstance: HOST }
    )
    await journal.appendQueuePauseMark('stopped', 0)
    await queueDraft(journal, 'after')
    await journal.resolveDispatch({
      clientMessageId: 'send-now-1',
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' }),
      fence: 0
    })
    expect(held(journal)).toEqual([
      ['steered', true],
      ['after', false]
    ])
  })

  it("'cleared' holds the carried cards, not one typed after them", async () => {
    const journal = await open()
    await queueDraft(journal, 'carried-1', 'source-session')
    await queueDraft(journal, 'carried-2', 'source-session')
    await queueDraft(journal, 'typed-here')
    expect(held(journal)).toEqual([
      ['carried-1', true],
      ['carried-2', true],
      ['typed-here', false]
    ])
  })
})

describe("a restart's pause", () => {
  it("adopting a restart's rows moves them into this instance and clears an older build's stored 'stopped' hold; send_failed stays", async () => {
    const journal = await open()
    await journal.queuedMessages.insert({
      messageId: 'draft-restart',
      body: message('written before the restart'),
      fingerprint: 'fp-draft-restart',
      hostInstance: 'proc-0'
    })
    expect(reason(journal)).toBe('restarted')
    await queueDraft(journal, 'draft-legacy')
    await queueDraft(journal, 'draft-failed')
    await journal.queuedMessages.hold({ messageIds: ['draft-failed'], reason: 'send_failed' })
    const db = new Database(journalDatabasePath(root))
    db.prepare("UPDATE queued_messages SET hold_reason = 'stopped' WHERE message_id = ?").run(
      'draft-legacy'
    )
    db.close()
    journal.queuedMessages.invalidate()
    expect(await journal.queuedMessages.adopt(HOST)).toBe(true)
    expect(reason(journal)).toBeNull()
    expect(
      journal.queuedMessages.list().map((row) => [row.messageId, row.hostInstance, row.holdReason])
    ).toEqual([
      ['draft-restart', HOST, null],
      ['draft-legacy', HOST, null],
      ['draft-failed', HOST, 'send_failed']
    ])
  })

  it('an adoption with nothing to adopt changes nothing and fires no commit notification', async () => {
    const journal = await open()
    await queueDraft(journal, 'draft-1')
    const revision = journal.queuedMessages.revision()
    expect(await journal.queuedMessages.adopt(HOST)).toBe(false)
    expect(journal.queuedMessages.revision()).toBe(revision)
  })
})
