// The background copy as the host builds it (reveal, the copy control, the job), not a job a test
// assembles: every copy it causes, a restored chat's own owed import included, runs through its
// pace.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeTestJournalHostDatabases } from '../agent-session-journal/journal-host-database-test-support'
import type * as PerSessionImport from '../agent-session-journal/journal-per-session-import'
import { importPerSessionJournal } from '../agent-session-journal/journal-per-session-import'
import {
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
  vi.mocked(importPerSessionJournal).mockClear()
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  closeTestJournalHostDatabases()
})

describe('the copy the host starts (G2)', () => {
  it('paces every copy, a restored chat’s owed import as much as an unlisted chat’s', async () => {
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
    // The restore previewed the listed chat: its copy is now that chat's own owed import.
    const restored = rig.host.collaboratorsForTests().sessions.get('session-listed')!.journal
    expect(restored.importPending).toBe(true)
    vi.mocked(importPerSessionJournal).mockClear()

    rig.host.startPerChatFileCopy({ listedIds: listed, isRuntimeChatWorkActive: () => false })
    rig.clock.now += 11_000
    await vi.waitFor(async () => expect(await perChatFilesLeft(rig)).toBe(0), {
      timeout: 10_000,
      interval: 100
    })

    const copies = vi.mocked(importPerSessionJournal).mock.calls.map(([input]) => ({
      sessionId: input.identity.sessionId,
      paced: typeof input.yieldTask === 'function'
    }))
    expect(copies.toSorted((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
      { sessionId: 'session-listed', paced: true },
      { sessionId: 'session-unlisted', paced: true }
    ])
    expect(restored.importPending).toBe(false)
  }, 20_000)
})
