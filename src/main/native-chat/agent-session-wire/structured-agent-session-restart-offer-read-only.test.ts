import { afterEach, expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import {
  insertTestJournalRowJson,
  liveTestJournalRows,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { AgentSessionJournalError } from '../agent-session-journal/journal-write-guards'
import { interruptedRestart } from './structured-agent-session-restart-interruption-test-harness'
import { StructuredAgentSessionResumeAdmission } from './structured-agent-session-restart-resume-runner'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'

// A chat whose journal this build keeps read-only (a newer Orca's) is not offered for resume and
// not counted as failed, and its offer is kept for an updated Orca to act on.

afterEach(() => vi.restoreAllMocks())

function journalsReadOnly() {
  return vi.spyOn(AgentSessionJournal.prototype, 'isReadOnly', 'get').mockReturnValue(true)
}

it('offers and runs nothing for a read-only chat, keeps its offer, and offers it again once writable', async () => {
  const { host, root, acquire } = await interruptedRestart()
  const readOnly = journalsReadOnly()

  expect(await host.restartResume.list()).toEqual([])
  const action = await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(action.continued).toEqual([])
  expect(acquire).not.toHaveBeenCalled()
  expect(await host.restartResume.listFailures()).toEqual([])
  expect((await new AgentSessionRecoveryCapsule(root).list(NOW)).map((m) => m.sessionId)).toEqual([
    SESSION
  ])

  readOnly.mockRestore()
  expect((await host.restartResume.list()).map((candidate) => candidate.sessionId)).toEqual([
    SESSION
  ])
})

it('keeps a failure already filed for a chat that is now read-only, but does not show it', async () => {
  const { host, acquire } = await interruptedRestart()
  await host.restartResume.list()
  acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(await host.restartResume.listFailures()).toMatchObject([{ sessionId: SESSION }])

  const readOnly = journalsReadOnly()
  expect(await host.restartResume.listFailures()).toEqual([])
  readOnly.mockRestore()
  expect(await host.restartResume.listFailures()).toMatchObject([
    { sessionId: SESSION, retryable: true }
  ])
})

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

async function nothingOfferedRunOrCounted(
  host: Awaited<ReturnType<typeof interruptedRestart>>['host'],
  root: string,
  acquire: ReturnType<typeof vi.fn>
) {
  expect(await host.restartResume.list()).toEqual([])
  expect((await host.restartResume.continueAfterRestart([SESSION], 'modal')).continued).toEqual([])
  expect(acquire).not.toHaveBeenCalled()
  expect(await host.restartResume.listFailures()).toEqual([])
  const capsule = new AgentSessionRecoveryCapsule(root)
  expect((await capsule.list(NOW)).map((marker) => marker.sessionId)).toEqual([SESSION])
  expect(await capsule.listFailed(NOW)).toEqual([])
}

it('keeps the offer of a chat whose journal really is read-only, and offers, runs and counts nothing', async () => {
  const { host, root, acquire } = await interruptedRestart()
  newerOrcaRow(root)
  await nothingOfferedRunOrCounted(host, root, acquire)
})

// A newer Orca's whole database: even a chat whose journal fails to open is a newer Orca's.
it('keeps the offer of every chat in a newer Orca database, and offers, runs and counts nothing', async () => {
  const { host, root, acquire } = await interruptedRestart()
  const database = openTestJournalHostDatabase(root)
  Object.defineProperty(database, 'readOnly', { value: true })
  // A table the newer schema changed: this chat's journal cannot be opened at all.
  database.db.exec('ALTER TABLE journal_sessions RENAME TO journal_sessions_newer')
  await nothingOfferedRunOrCounted(host, root, acquire)
})

// However a newer Orca's refusal reaches a send (a journal first opened when sending), it files
// nothing and keeps the offer.
it('keeps the offer and files nothing when the send is refused as a newer Orca chat', async () => {
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
  expect((await capsule.list(NOW)).map((marker) => marker.sessionId)).toEqual([SESSION])
  expect(await host.restartResume.listFailures()).toEqual([])
})

// Read-only first seen after the action chose the chat: the check right before sending must not
// turn it away as if the user had moved on, which would spend the offer.
it('keeps the offer of a chat first seen read-only when sending', async () => {
  const { host, root } = await interruptedRestart()
  await host.restartResume.list()
  const database = openTestJournalHostDatabase(root)
  // After the action chose the chat, before its send-time checks.
  const admit = StructuredAgentSessionResumeAdmission.prototype.run
  vi.spyOn(StructuredAgentSessionResumeAdmission.prototype, 'run').mockImplementation(
    async function (this, ...args) {
      Object.defineProperty(database, 'readOnly', { value: true, configurable: true })
      return admit.apply(this, args)
    }
  )
  vi.spyOn(AgentSessionJournal.prototype, 'appendSubmission').mockRejectedValue(
    new AgentSessionJournalError('journal_read_only', 'a newer Orca wrote this journal')
  )

  await host.restartResume.continueAfterRestart([SESSION], 'modal')

  const capsule = new AgentSessionRecoveryCapsule(root)
  expect((await capsule.list(NOW)).map((marker) => marker.sessionId)).toEqual([SESSION])
  expect(await capsule.listFailed(NOW)).toEqual([])
  expect(await host.restartResume.listFailures()).toEqual([])
})
