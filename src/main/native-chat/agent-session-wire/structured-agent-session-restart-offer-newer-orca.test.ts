import { afterEach, expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import {
  insertTestJournalRowJson,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  updateTestJournalRowJson
} from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { AgentSessionJournalError } from '../agent-session-journal/journal-write-guards'
import { interruptedRestart } from './structured-agent-session-restart-interruption-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'

// Nothing here can continue a chat a newer Orca saved: its restart offer is spent without a word,
// with no failure filed and nothing counted. Once Orca is updated, the user opens the chat and
// carries on by hand.

afterEach(() => vi.restoreAllMocks())

/** Writes a row of a kind this build does not know into the chat's journal, as a newer Orca would. */
function newerOrcaRow(root: string): void {
  const { db } = openTestJournalHostDatabase(root)
  const last = liveTestJournalRows(db, SESSION).at(-1)
  const parsed: unknown = last ? JSON.parse(last.rowJson) : null
  if (!last || typeof parsed !== 'object' || parsed === null || !('epoch' in parsed)) {
    throw new Error('the chat has no journal row to follow')
  }
  const { epoch } = parsed
  const seq = last.seq + 1
  insertTestJournalRowJson(
    db,
    SESSION,
    seq,
    JSON.stringify({
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      kind: 'future-mark',
      epoch,
      seq,
      fence: 1,
      ts: NOW
    }),
    NOW
  )
}

async function spentWithoutAWord(
  host: Awaited<ReturnType<typeof interruptedRestart>>['host'],
  root: string,
  acquire: ReturnType<typeof vi.fn>
) {
  expect(await host.restartResume.list()).toEqual([])
  expect((await host.restartResume.continueAfterRestart([SESSION], 'modal')).continued).toEqual([])
  expect(acquire).not.toHaveBeenCalled()
  expect(await host.restartResume.listFailures()).toEqual([])
  const capsule = new AgentSessionRecoveryCapsule(root)
  expect(await capsule.list(NOW)).toEqual([])
  expect(await capsule.listFailed(NOW)).toEqual([])
}

it('spends the offer of a chat whose journal a newer Orca wrote, and runs and counts nothing', async () => {
  const { host, root, acquire } = await interruptedRestart()
  newerOrcaRow(root)
  await spentWithoutAWord(host, root, acquire)
})

// A newer Orca's whole database: every chat in it is a newer Orca's, even one whose tables changed.
it('spends the offer of every chat in a newer Orca database, and runs and counts nothing', async () => {
  const { host, root, acquire } = await interruptedRestart()
  const database = openTestJournalHostDatabase(root)
  Object.defineProperty(database, 'readOnly', { value: true })
  database.db.exec('ALTER TABLE journal_sessions RENAME TO journal_sessions_newer')
  await spentWithoutAWord(host, root, acquire)
})

// However a newer Orca's refusal reaches a send (a journal first opened when sending), it files
// nothing and spends the offer.
it('spends the offer and files nothing when the send is refused as a newer Orca chat', async () => {
  const { host, root } = await interruptedRestart()
  await host.restartResume.list()
  vi.spyOn(AgentSessionJournal.prototype, 'appendSubmission').mockRejectedValue(
    new AgentSessionJournalError('journal_read_only', 'a newer Orca wrote this journal')
  )

  const action = await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(action.continued).toMatchObject([
    {
      outcome: 'refused',
      reason: 'agent_session_journal_unreadable',
      refusal: { details: { reason: 'journalWrittenByNewerOrca' } }
    }
  ])
  const capsule = new AgentSessionRecoveryCapsule(root)
  expect(await capsule.listFailed(NOW)).toEqual([])
  expect(await capsule.list(NOW)).toEqual([])
  expect(await host.restartResume.listFailures()).toEqual([])
})

// What listing does with a journal that throws for another reason: a damaged chat stays offered,
// and acting on it files the failure, which names the damage.
it('still offers a damaged chat, and files its failure when acting on it', async () => {
  const { host, root, acquire } = await interruptedRestart()
  updateTestJournalRowJson(openTestJournalHostDatabase(root).db, SESSION, 1, '}{')

  expect((await host.restartResume.list()).map((candidate) => candidate.sessionId)).toEqual([
    SESSION
  ])
  await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(acquire).not.toHaveBeenCalled()
  expect(await host.restartResume.listFailures()).toMatchObject([
    {
      sessionId: SESSION,
      reason: 'agent_session_journal_unreadable',
      details: { reason: 'journalCorrupt' }
    }
  ])
})
