// A chat whose stored status says it owes work, and whose history is damaged since: startup selects
// it once, its open fails and drops that row, so the next launch selects nothing. Every row stays.

import { afterEach, expect, it, vi } from 'vitest'
import {
  closeTestJournalHostDatabases,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus,
  updateTestJournalRowJson
} from '../agent-session-journal/journal-host-database-test-support'
import { readUnsettledJournalSessionIds } from '../agent-session-journal/journal-session-state'
import { createRestTestRig, type RestTestRig } from './structured-agent-session-rest-test-rig'
import {
  crashRestTestChatMidTurn,
  runRestTestStartup
} from './structured-agent-session-rest-test-startup'

const SESSION = 'session-damaged'
const rigs: RestTestRig[] = []

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
})

/** Each warning startup logged about the chat. */
function warningsFor(warn: ReturnType<typeof vi.spyOn>): unknown[] {
  return warn.mock.calls.filter(
    ([, fields]) =>
      typeof fields === 'object' &&
      fields !== null &&
      'sessionId' in fields &&
      fields.sessionId === SESSION
  )
}

it.each([true, false])(
  'drops the stored mid-turn status of a damaged chat in one launch, so the next selects nothing (listed: %s)',
  async (listed) => {
    const rig = await createRestTestRig()
    rigs.push(rig)
    await crashRestTestChatMidTurn(rig, SESSION, { listed })
    await rig.crash()
    const { db } = openTestJournalHostDatabase(rig.root)
    // Damaged in place: the row still names the chat's tip, so startup selects it.
    updateTestJournalRowJson(db, SESSION, 2, '{')
    const rows = liveTestJournalRows(db, SESSION).length
    expect(readUnsettledJournalSessionIds(db)).toEqual([SESSION])

    await rig.boot()
    const warn = vi.spyOn(rig.host.deps.logger, 'warn')
    await runRestTestStartup(rig)

    expect(warningsFor(warn)).toHaveLength(1)
    expect(readTestJournalSessionStatus(rig.root, SESSION)).toBeNull()
    expect(readUnsettledJournalSessionIds(db)).toEqual([])
    expect(liveTestJournalRows(db, SESSION)).toHaveLength(rows)

    // The obligation died with the row: the next launch selects and opens nothing, and says nothing.
    await rig.crash()
    await rig.boot()
    const again = vi.spyOn(rig.host.deps.logger, 'warn')
    await runRestTestStartup(rig)
    expect(rig.journalOpens.mock.calls.filter(([id]) => id === SESSION)).toEqual(
      listed ? [[SESSION]] : []
    )
    expect(warningsFor(again)).toHaveLength(listed ? 1 : 0)
    expect(readUnsettledJournalSessionIds(db)).toEqual([])
  }
)
