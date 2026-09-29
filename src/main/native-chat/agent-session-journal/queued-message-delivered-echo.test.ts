// A draft sent back to waiting after a "never delivered" rejection is withdrawn
// when the provider echoes that message: the first send reached the agent, so
// sending it again would repeat it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { queuedMessageFingerprint } from '../agent-session-wire/structured-agent-session-queued-messages'
import type { AgentSessionJournal } from './journal-store'
import { createTrackedJournalOpener } from './journal-store-test-open'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-q',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: { kind: 'claude', sessionId: 'native-1', leafUuid: null }
}
const STOP_WITHDRAWAL = agentSessionFailureWords(agentSessionFailureFact('cancelled'), {
  surface: 'rejection'
})

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function echo(journal: AgentSessionJournal, uuid: string, text: string) {
  return journal.appendItem({ provider: 'claude', sessionId: 'native-1', uuid }, message(text), {
    fence: 0
  })
}

/** A draft consumed, then withdrawn by a Stop before the agent had it: back to waiting. */
async function withdrawnDraft(text: string): Promise<AgentSessionJournal> {
  const journal = await journals.open({
    identity: IDENTITY,
    journalDir: root,
    now: () => ++clock,
    mintEpoch: () => `epoch-${clock}`
  })
  const body = message(text)
  const fingerprint = queuedMessageFingerprint(IDENTITY.sessionId, body)
  await journal.queuedMessages.insert({
    messageId: 'draft-1',
    body,
    fingerprint,
    hostInstance: 'p'
  })
  await journal.appendSubmission(
    {
      clientMessageId: 'sub-draft-1',
      payloadFingerprint: fingerprint,
      body,
      fence: 0,
      handoverRecorded: true
    },
    { messageId: 'draft-1', expect: 'waiting', settledByOp: null }
  )
  await journal.rejectQueuedSubmissions(0, STOP_WITHDRAWAL)
  expect(journal.queuedMessages.get('draft-1')).toMatchObject({
    state: 'waiting',
    consumedAs: null
  })
  return journal
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-queued-echo-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe("a waiting draft whose 'never delivered' claim an echo disproves", () => {
  it('is withdrawn when the provider echoes the message it was withdrawn from', async () => {
    const journal = await withdrawnDraft('did it land?')
    await echo(journal, 'echo-1', 'did it land?')
    expect(journal.queuedMessages.get('draft-1')).toMatchObject({
      state: 'withdrawn',
      settledByOp: null
    })
    // The rejection stays terminal: the echo is kept apart, not folded into it.
    expect(journal.submission('sub-draft-1')?.dispatchState).toBe('rejected')
    expect(journal.snapshot().items.map((item) => item.itemId)).toHaveLength(2)
  })

  it('stays waiting for an echo of some other text', async () => {
    const journal = await withdrawnDraft('did it land?')
    await echo(journal, 'echo-1', 'something else')
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('waiting')
  })

  it('stays waiting when a live send of the same text claims the echo', async () => {
    const journal = await withdrawnDraft('did it land?')
    const body = message('did it land?')
    await journal.appendSubmission({
      clientMessageId: 'typed-again',
      payloadFingerprint: queuedMessageFingerprint(IDENTITY.sessionId, body),
      body,
      fence: 0,
      handoverRecorded: true
    })
    await echo(journal, 'echo-1', 'did it land?')
    expect(journal.submission('typed-again')?.dispatchState).toBe('accepted')
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('waiting')
  })
})
