// Which sends an earlier host process left queued become held cards, where they go in the queue,
// and that a send's source is recorded and folded.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission,
  AgentJournalSubmissionSource,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import { structuredAgentSessionCompactBody } from '../agent-session-wire/structured-agent-session-command-turn'
import { holdJournalLeftoverSends, leftoverSendHeldAsCard } from './journal-leftover-send-hold'
import type { AgentSessionJournal } from './journal-store'
import { QUEUED_MESSAGE_HELD_ACROSS_RESTART } from './queued-message-pause'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener
} from './journal-host-database-test-support'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-held',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: { kind: 'claude', sessionId: 'native-1', leafUuid: null }
}
const HOST_RESTARTED = agentSessionFailureWords(agentSessionFailureFact('hostRestarted'), {
  surface: 'rejection'
})

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function fingerprint(body: AgentJournalMessageItem): string {
  return structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId: IDENTITY.sessionId,
    fields: { body }
  })
}

async function open(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: () => (clock += 1),
    mintEpoch: () => 'epoch-1'
  })
}

async function accept(
  journal: AgentSessionJournal,
  id: string,
  fields: {
    body?: AgentJournalMessageItem
    origin?: 'client' | 'host'
    source?: AgentJournalSubmissionSource
  } = {}
): Promise<void> {
  const body = fields.body ?? message(`text of ${id}`)
  await journal.appendSubmission({
    clientMessageId: id,
    payloadFingerprint: fingerprint(body),
    body,
    fence: 0,
    handoverRecorded: true,
    ...(fields.origin ? { origin: fields.origin } : {}),
    ...(fields.source ? { source: fields.source } : {})
  })
}

/** Writes rows as a process that then quit, and opens the journal again as the next one. */
async function afterRestart(
  write: (journal: AgentSessionJournal) => Promise<void>
): Promise<AgentSessionJournal> {
  const earlier = await open()
  await write(earlier)
  await earlier.close()
  return open()
}

function cardOrder(journal: AgentSessionJournal): string[] {
  return journal.queuedMessages
    .list()
    .filter((card) => card.state === 'waiting')
    .map((card) => card.messageId)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-leftover-hold-'))
})

afterEach(async () => {
  await journals.closeAll()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

describe('which leftover sends are kept', () => {
  it('keeps a person’s and a launch’s text, and an older build’s client send', async () => {
    const journal = await afterRestart(async (earlier) => {
      await accept(earlier, 'person', { origin: 'client', source: 'person' })
      await accept(earlier, 'launch', { origin: 'host', source: 'launch' })
      await accept(earlier, 'legacy-client', { origin: 'client' })
    })
    await holdJournalLeftoverSends(journal, 0)

    expect(cardOrder(journal)).toEqual(['person', 'launch', 'legacy-client'])
    for (const id of ['person', 'launch', 'legacy-client']) {
      expect(journal.submission(id)).toMatchObject({ dispatchState: 'rejected', ...HOST_RESTARTED })
      expect(journal.queuedMessages.get(id)).toMatchObject({
        state: 'waiting',
        hostInstance: QUEUED_MESSAGE_HELD_ACROSS_RESTART,
        body: message(`text of ${id}`),
        fingerprint: fingerprint(message(`text of ${id}`)),
        carriedFrom: null,
        queuedAt: { epoch: 'epoch-1', sequence: journal.submission(id)?.acceptedSequence }
      })
    }
  })

  it('rejects mail, a continuation, /compact, an image, and a send no one can attribute', async () => {
    const image: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'look' },
        { type: 'image-ref', path: '/tmp/attachment.png' }
      ]
    }
    const journal = await afterRestart(async (earlier) => {
      await accept(earlier, 'mail', { origin: 'host', source: 'mail' })
      await accept(earlier, 'continuation', { origin: 'host', source: 'continuation' })
      await accept(earlier, 'compact', {
        origin: 'client',
        source: 'person',
        body: structuredAgentSessionCompactBody()
      })
      await accept(earlier, 'image', { origin: 'client', source: 'person', body: image })
      await accept(earlier, 'legacy-host', { origin: 'host' })
      await accept(earlier, 'no-origin')
    })
    await holdJournalLeftoverSends(journal, 0)

    expect(journal.queuedMessages.list()).toEqual([])
    for (const id of ['mail', 'continuation', 'compact', 'image', 'legacy-host', 'no-origin']) {
      expect(journal.submission(id)).toMatchObject({ dispatchState: 'rejected', ...HOST_RESTARTED })
    }
  })

  it('a card’s own hand-off returns its card, and makes no second one', async () => {
    const journal = await afterRestart(async (earlier) => {
      await earlier.queuedMessages.insert({
        messageId: 'card',
        body: message('card text'),
        fingerprint: fingerprint(message('card text')),
        hostInstance: 'proc-1'
      })
      await earlier.appendSubmission(
        {
          clientMessageId: 'handoff',
          payloadFingerprint: fingerprint(message('card text')),
          body: message('card text'),
          fence: 0,
          handoverRecorded: true,
          origin: 'host',
          source: 'queue'
        },
        { messageId: 'card', expect: 'waiting', settledByOp: null }
      )
    })
    await holdJournalLeftoverSends(journal, 0)

    expect(journal.queuedMessages.list()).toHaveLength(1)
    expect(journal.queuedMessages.get('card')).toMatchObject({ state: 'waiting', consumedAs: null })
    expect(journal.queuedMessages.get('handoff')).toBeNull()
  })

  it('leaves alone what this process accepted', async () => {
    const journal = await open()
    await accept(journal, 'mine', { origin: 'client', source: 'person' })
    await holdJournalLeftoverSends(journal, 0)
    expect(journal.submission('mine')?.dispatchState).toBe('pending')
    expect(journal.queuedMessages.list()).toEqual([])
  })

  it('never keeps a queue hand-off, a card’s link, or a send with no message body', () => {
    const body = message('x')
    expect(leftoverSendHeldAsCard({ source: 'person' }, body)).toBe(body)
    expect(leftoverSendHeldAsCard({ source: 'queue' }, body)).toBeNull()
    expect(leftoverSendHeldAsCard({ origin: 'client', queuedMessageId: 'card' }, body)).toBeNull()
    expect(leftoverSendHeldAsCard({ origin: 'client' }, null)).toBeNull()
  })
})

describe('where kept sends go in the queue', () => {
  it('in acceptance order, a returned hand-off among them, all ahead of the cards already waiting', async () => {
    const journal = await afterRestart(async (earlier) => {
      await earlier.queuedMessages.insert({
        messageId: 'H',
        body: message('H'),
        fingerprint: fingerprint(message('H')),
        hostInstance: 'proc-1'
      })
      await earlier.queuedMessages.insert({
        messageId: 'C',
        body: message('C'),
        fingerprint: fingerprint(message('C')),
        hostInstance: 'proc-1'
      })
      await accept(earlier, 'A', { origin: 'client', source: 'person' })
      await earlier.appendSubmission(
        {
          clientMessageId: 'H-handoff',
          payloadFingerprint: fingerprint(message('H')),
          body: message('H'),
          fence: 0,
          handoverRecorded: true,
          origin: 'host',
          source: 'queue'
        },
        { messageId: 'H', expect: 'waiting', settledByOp: null }
      )
      await accept(earlier, 'B', { origin: 'client', source: 'person' })
    })
    await holdJournalLeftoverSends(journal, 0)

    expect(cardOrder(journal)).toEqual(['A', 'H', 'B', 'C'])
  })

  it('a run a crash cut short is placed again with the rest, in acceptance order', async () => {
    const interrupted = await afterRestart(async (earlier) => {
      await earlier.queuedMessages.insert({
        messageId: 'C',
        body: message('C'),
        fingerprint: fingerprint(message('C')),
        hostInstance: 'proc-1'
      })
      await accept(earlier, 'A', { origin: 'client', source: 'person' })
      await accept(earlier, 'B', { origin: 'client', source: 'person' })
    })
    // That run kept A, at a stale place behind C, then died before B.
    await interrupted.resolveDispatch(
      { clientMessageId: 'A', state: 'rejected', ...HOST_RESTARTED, fence: 0, recovered: true },
      (db) => {
        interrupted.queuedMessages.holdInTransaction(db, {
          card: {
            messageId: 'A',
            body: message('text of A'),
            fingerprint: fingerprint(message('text of A')),
            hostInstance: QUEUED_MESSAGE_HELD_ACROSS_RESTART,
            queuedAt: {
              epoch: 'epoch-1',
              sequence: interrupted.submission('A')!.acceptedSequence!
            },
            position: 5
          },
          positions: []
        })
      }
    )
    await interrupted.close()
    const journal = await open()
    await holdJournalLeftoverSends(journal, 0)

    expect(cardOrder(journal)).toEqual(['A', 'B', 'C'])
  })
})

describe('the source a send records', () => {
  it('is folded from the row; a row without one folds without it', async () => {
    const journal = await open()
    await accept(journal, 'with-source', { origin: 'host', source: 'launch' })
    await accept(journal, 'without', { origin: 'client' })
    const folded: AgentJournalSubmission | undefined = journal.submission('with-source')
    expect(folded?.source).toBe('launch')
    expect(journal.submission('without')).not.toHaveProperty('source')
  })
})
