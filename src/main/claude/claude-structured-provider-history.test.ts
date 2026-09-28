// The Claude history an attach samples, read end to end: transcript file, liveness, journal verdict.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import { reconcileJournalSubmissionsAgainstHistory } from '../native-chat/agent-session-journal/journal-restart-reconciliation'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-store-test-open'
import { claudePromptFingerprint } from './claude-structured-history-window'
import { openClaudeProviderHistory } from './claude-structured-provider-history'

const PROVIDER_SESSION = 'provider-1'

// No turn has completed yet, so there is no durable anchor.
const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'claude',
  providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION, leafUuid: null }
}

const journals = createTrackedJournalOpener()
let root: string

function userMessage(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

async function writeTranscript(rows: Record<string, unknown>[]): Promise<void> {
  const projectDir = join(root, 'account', 'projects', 'work')
  await mkdir(projectDir, { recursive: true })
  await writeFile(
    join(projectDir, `${PROVIDER_SESSION}.jsonl`),
    rows.map((row) => `${JSON.stringify(row)}\n`).join('')
  )
}

function userRow(uuid: string, content: unknown): Record<string, unknown> {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    sessionId: PROVIDER_SESSION,
    message: { role: 'user', content }
  }
}

function frameIdentity(uuid: string) {
  return { provider: 'claude' as const, sessionId: PROVIDER_SESSION, uuid }
}

type Journal = Awaited<ReturnType<typeof journals.open>>

/** A send handed over under frame `uuid`, fingerprinted as the send path does. */
async function handOver(journal: Journal, clientMessageId: string, uuid: string, text: string) {
  await journal.appendSubmission({
    clientMessageId,
    payloadFingerprint: claudePromptFingerprint(IDENTITY.sessionId, [{ type: 'text', text }]),
    body: userMessage(text),
    fence: 1
  })
  await journal.resolveDispatch({
    clientMessageId,
    state: 'pending',
    providerIdentity: frameIdentity(uuid),
    fence: 1
  })
}

/** Writes the journal as `write` leaves it, then restarts the host over it with no child running. */
async function restartAfter(write: (journal: Journal) => Promise<void>, hasLiveSession = false) {
  const journalDir = join(root, 'journal')
  await write(await journals.open({ identity: IDENTITY, journalDir }))
  const reopened = await journals.open({ identity: IDENTITY, journalDir })
  await reopened.markPendingSubmissionsUnknown(2)
  const history = openClaudeProviderHistory({
    identity: IDENTITY,
    accountHomePath: join(root, 'account'),
    hasLiveSession
  })
  await reconcileJournalSubmissionsAgainstHistory({
    journal: reopened,
    fence: 2,
    history: history!
  })
  return Object.fromEntries(
    reopened
      .submissions()
      .map((submission) => [submission.clientMessageId, submission.dispatchState])
  )
}

/** A transcript holding only a turn Claude is still running, and a send handed over during it. */
async function strandedMidTurn(hasLiveSession: boolean) {
  await writeTranscript([userRow('running-turn', 'run the tests')])
  return restartAfter((journal) => handOver(journal, 'cm-sent', 'sent', 'ship it'), hasLiveSession)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-provider-history-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('openClaudeProviderHistory', () => {
  it('leaves a send unknown while a turn runs, even with no anchor to read a window from', async () => {
    // Claude may not have written the record yet, so its absence proves nothing.
    expect(await strandedMidTurn(true)).toEqual({ 'cm-sent': 'unknown' })
  })

  it('decides the same send not delivered once no child can still be writing', async () => {
    expect(await strandedMidTurn(false)).toEqual({ 'cm-sent': 'rejected' })
  })

  it.each([false, true])(
    'leaves a send unknown when Claude merged it into the row of the send after it (that send accepted: %s)',
    async (secondAccepted) => {
      // Frames queued together behind a turn share one row under the later frame's uuid.
      await writeTranscript([
        userRow('second', [
          { type: 'text', text: 'ship it' },
          { type: 'text', text: 'and test it' }
        ])
      ])

      const states = await restartAfter(async (journal) => {
        await handOver(journal, 'cm-first', 'first', 'ship it')
        await handOver(journal, 'cm-second', 'second', 'and test it')
        if (secondAccepted) {
          await journal.resolveDispatch({
            clientMessageId: 'cm-second',
            state: 'accepted',
            providerIdentity: frameIdentity('second'),
            fence: 1
          })
        }
      })

      expect(states).toEqual({ 'cm-first': 'unknown', 'cm-second': 'accepted' })
    }
  )

  it('decides a repeat of an older message the journal holds not delivered', async () => {
    await writeTranscript([userRow('older', 'ship it')])

    const states = await restartAfter(async (journal) => {
      await journal.appendItem(frameIdentity('older'), userMessage('ship it'), { fence: 1 })
      await handOver(journal, 'cm-repeat', 'repeat', 'ship it')
    })

    // The only copy of the text is the older row's own, so the repeat is provably missing.
    expect(states).toEqual({ 'cm-repeat': 'rejected' })
  })
})
