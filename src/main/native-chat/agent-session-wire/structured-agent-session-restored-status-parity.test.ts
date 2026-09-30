// Status rows now arrive after the tab list, from the post-listing restore pass. Each must end
// exactly where a fresh host lands when the same chat is opened directly by a read (T8, regression
// guard: the pass is main's own open path; this pins that moving it after the list changed nothing).

import { cp } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { closeTestJournalHostDatabases } from '../agent-session-journal/journal-host-database-test-support'
import {
  createStartupRig,
  latestStatus,
  type StartupRig
} from './structured-agent-session-startup-listing-test-rig'

const rigs: StartupRig[] = []

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
})

const CORPUS = ['session-settled', 'session-quiet', 'session-crashed', 'session-pending']

/** The chats a restart finds: two a clean quit settled, one cut off mid-turn by a crash, and one
 *  whose send the provider only admitted, left pending below a fence that has since moved. */
async function seedCorpus(rig: StartupRig): Promise<void> {
  await rig.chat('session-settled', { message: 'finished work' })
  await rig.chat('session-quiet')
  await rig.host.flushAllStreamedEvents()
  await rig.boot()
  await rig.chat('session-crashed', { message: 'cut off' })
  rig.dispatch.mockResolvedValueOnce({ state: 'admitted' })
  await rig.chat('session-pending', { message: 'only admitted' })
  await rig.crash()
  await rig.store.transitionHandoff('session-pending', (record) => ({
    ...record,
    lease: { ...record.lease, runtimeFence: record.lease.runtimeFence + 1 }
  }))
}

it('ends every chat where a direct read of it lands, and shows no pre-crash work (T8)', async () => {
  const passRig = await createStartupRig()
  rigs.push(passRig)
  await seedCorpus(passRig)
  // One copy of the files for each boot, taken while nothing is writing.
  closeTestJournalHostDatabases()
  const readRoot = `${passRig.root}-read`
  await cp(passRig.root, readRoot, { recursive: true })
  const readRig = await createStartupRig(readRoot)
  rigs.push(readRig)

  // Startup's shape: the lease check started, the list answered, then the pass.
  const passHost = await passRig.boot()
  const passCheck = passHost.reconcileRestartLeases()
  await passHost.restoreReadableSessions(CORPUS)
  await passCheck

  // The same run, where the window reads each chat instead.
  const readHost = readRig.host
  const readCheck = readHost.reconcileRestartLeases()
  for (const sessionId of CORPUS) {
    await readHost.history({ sessionId, direction: 'tail' })
  }
  await readCheck

  // `updatedAt` is when the row was projected, a wall-clock read that differs between two boots.
  const rows = (rig: StartupRig): Record<string, Omit<AgentSessionStatusSummary, 'updatedAt'>> =>
    Object.fromEntries(
      CORPUS.flatMap((sessionId) => {
        const summary = latestStatus(rig, sessionId)
        if (!summary) {
          return []
        }
        const { updatedAt: _updatedAt, ...row } = summary
        return [[sessionId, row]]
      })
    )
  await vi.waitFor(() => expect(rows(passRig)).toEqual(rows(readRig)))
  for (const sessionId of CORPUS) {
    expect(latestStatus(passRig, sessionId)).toBeDefined()
  }
  const crashedRows = passRig.statusEvents.flatMap((event) =>
    event.type === 'status' && event.session.sessionId === 'session-crashed' ? [event.session] : []
  )
  expect(crashedRows.map((row) => row.status)).not.toContain('working')
})
