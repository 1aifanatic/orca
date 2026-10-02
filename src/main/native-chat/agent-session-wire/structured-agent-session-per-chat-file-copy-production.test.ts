// The background copy as the host builds it (reveal, the copy control, the job), not a job a test
// assembles: a restored chat's own owed import is charged to the copy's pace, and a reader of that
// chat never waits for the pace.

import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeTestJournalHostDatabases } from '../agent-session-journal/journal-host-database-test-support'
import type * as PerSessionImport from '../agent-session-journal/journal-per-session-import'
import { importPerSessionJournal } from '../agent-session-journal/journal-per-session-import'
import { StructuredAgentSessionPerChatFileCopy } from './structured-agent-session-per-chat-file-copy'
import { StructuredAgentSessionPerChatFileCopyPace } from './structured-agent-session-per-chat-file-copy-pace'
import {
  copyJobDeps,
  createChats,
  createCopyTestRig,
  moveToPerChatFiles,
  perChatFilesLeft,
  type CopyTestRig
} from './structured-agent-session-per-chat-file-copy-test-rig'

vi.mock('../agent-session-journal/journal-per-session-import', async (importOriginal) => {
  const actual = await importOriginal<typeof PerSessionImport>()
  return { ...actual, importPerSessionJournal: vi.fn(actual.importPerSessionJournal) }
})

const rigs: CopyTestRig[] = []

afterEach(async () => {
  vi.mocked(importPerSessionJournal).mockReset()
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  closeTestJournalHostDatabases()
})

/** A listed chat the startup restore opened from its old file, and an unlisted one, both still
 *  in their files. */
async function restoredAndUnlisted(): Promise<CopyTestRig> {
  const rig = await createCopyTestRig()
  rigs.push(rig)
  await createChats(rig, ['session-listed'])
  await createChats(rig, ['session-unlisted'], { listed: false })
  await rig.crash()
  moveToPerChatFiles(rig, ['session-listed', 'session-unlisted'])
  await rig.boot()
  const listed = rig.store.getVisibleSessionTabIndex().sessionIds
  await rig.host.reconcileRestartLeases()
  const background = rig.host.seedStoredStatuses(listed)
  await rig.host.settleOwedSessions(listed)
  await rig.host.restoreReadableSessions(background)
  expect(restoredJournal(rig).importPending).toBe(true)
  return rig
}

const restoredJournal = (rig: CopyTestRig) =>
  rig.host.collaboratorsForTests().sessions.get('session-listed')!.journal

describe('a restored chat’s copy (G2, R6)', () => {
  it('is charged to the pace the host starts, which pays it before the next chat', async () => {
    const rig = await restoredAndUnlisted()
    const actual = await vi.importActual<typeof PerSessionImport>(
      '../agent-session-journal/journal-per-session-import'
    )
    const at: Record<string, number> = {}
    vi.mocked(importPerSessionJournal).mockImplementation(async (input) => {
      const { sessionId } = input.identity
      at[`${sessionId}:start`] = performance.now()
      // The restored chat's copy takes 400 ms of the main thread's wall time.
      if (sessionId === 'session-listed') {
        await sleep(400)
      }
      const result = await actual.importPerSessionJournal(input)
      at[`${sessionId}:end`] = performance.now()
      return result
    })

    rig.host.startPerChatFileCopy({
      listedIds: rig.store.getVisibleSessionTabIndex().sessionIds,
      isRuntimeChatWorkActive: () => false
    })
    rig.clock.now += 11_000
    await vi.waitFor(async () => expect(await perChatFilesLeft(rig)).toBe(0), {
      timeout: 15_000,
      interval: 100
    })

    // 400 ms charged against a 50 ms burst is a debt worth about two seconds at the share.
    expect(at['session-unlisted:start'] - at['session-listed:end']).toBeGreaterThan(1_000)
    expect(restoredJournal(rig).importPending).toBe(false)
  }, 30_000)

  it('never holds a reader of the restored chat for the pace', async () => {
    const rig = await restoredAndUnlisted()
    let paceWaiting = false
    let clock = 0
    // Every task reads as a second of work, and a wait lasts until quit ends it.
    const pace = new StructuredAgentSessionPerChatFileCopyPace(
      () => (clock += 1_000),
      (_ms, signal) => {
        paceWaiting = true
        return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      }
    )
    const job = new StructuredAgentSessionPerChatFileCopy({ ...copyJobDeps(rig), pace })
    const run = job.tick()

    // What a history read, a subscribe or a reveal of the open chat waits for.
    const read = await Promise.race([
      restoredJournal(rig)
        .whenImported()
        .then(() => 'read'),
      sleep(5_000).then(() => 'still waiting')
    ])

    expect(read).toBe('read')
    await vi.waitFor(() => expect(paceWaiting).toBe(true))
    await job.stop()
    await run
  }, 20_000)
})
