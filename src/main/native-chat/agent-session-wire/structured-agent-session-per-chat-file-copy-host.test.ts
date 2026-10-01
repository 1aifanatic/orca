// The background copy on a real host: every old per-chat file copied so the next launch reads none
// and seeds every listed chat at paint, a chat a crash cut settled by the copy itself with no
// replay, a restored chat's copy adopting the copy's fold, and every chat already in the database
// given the status row the version 5 migration left it without.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus
} from '../agent-session-journal/journal-host-database-test-support'
import type * as JournalOpen from '../agent-session-journal/journal-open'
import { replayJournal } from '../agent-session-journal/journal-open'
import {
  isUnsettledJournalSessionStatus,
  readUnsettledJournalSessionIds
} from '../agent-session-journal/journal-session-state'
import { createStructuredAgentSessionPerChatFileCopyControl } from './structured-agent-session-per-chat-file-copy-control'
import {
  copyJob,
  createChats,
  createCopyTestRig,
  hasPerChatFile,
  moveToPerChatFiles,
  perChatFilesLeft,
  runToEnd,
  type CopyTestRig
} from './structured-agent-session-per-chat-file-copy-test-rig'
import { restTestChat, sendRestTestMessage } from './structured-agent-session-rest-test-rig'

vi.mock('../agent-session-journal/journal-open', async (importOriginal) => {
  const actual = await importOriginal<typeof JournalOpen>()
  return { ...actual, replayJournal: vi.fn(actual.replayJournal) }
})

const rigs: CopyTestRig[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  closeTestJournalHostDatabases()
})

async function newRig(): Promise<CopyTestRig> {
  const rig = await createCopyTestRig()
  rigs.push(rig)
  return rig
}

/** A send the provider only admitted: the crash leaves it handed over and unanswered. */
async function crashMidSend(rig: CopyTestRig, sessionId: string, listed: boolean): Promise<void> {
  rig.adapter.dispatch.mockResolvedValueOnce({ state: 'admitted' })
  await restTestChat(rig, sessionId, { message: `asked ${sessionId}`, listed })
}

/** What startup runs on the listed ids; answers what the post-listing restore still opens. */
async function startup(rig: CopyTestRig): Promise<string[]> {
  const listed = rig.store.getVisibleSessionTabIndex().sessionIds
  await rig.host.reconcileRestartLeases()
  const background = rig.host.seedStoredStatuses(listed)
  await rig.host.settleOwedSessions(listed)
  await rig.host.restoreReadableSessions(background)
  return background
}

const db = (rig: CopyTestRig) => openTestJournalHostDatabase(rig.root).db

describe('every old file copied, and the next launch reads none (T1, T4)', () => {
  it('copies every chat, listed ones first, and the next launch seeds every listed chat at paint', async () => {
    const rig = await newRig()
    const listed = ['session-l0', 'session-l1', 'session-l2']
    const unlisted = Array.from({ length: 9 }, (_, index) => `session-u${index}`)
    await createChats(rig, listed)
    await createChats(rig, unlisted, { listed: false })
    await rig.crash()
    moveToPerChatFiles(rig, [...listed, ...unlisted])
    await rig.boot()

    await runToEnd(rig, copyJob(rig))

    expect(await perChatFilesLeft(rig)).toBe(0)
    expect(db(rig).prepare('SELECT count(*) AS n FROM journal_imports').get()).toEqual({ n: 12 })
    await rig.crash()
    await rig.boot()
    // Every listed chat has its stored status, so nothing is left for the post-listing restore.
    expect(await startup(rig)).toEqual([])
    for (const sessionId of listed) {
      expect(readTestJournalSessionStatus(rig.root, sessionId)?.status).toBe('idle')
    }
  })
})

describe('a chat a crash cut, settled by the copy (T5, C2)', () => {
  it('settles a copied chat with work left from its copy’s fold, so startup selects nothing', async () => {
    const rig = await newRig()
    await crashMidSend(rig, 'session-cut', false)
    await rig.crash()
    moveToPerChatFiles(rig, ['session-cut'])
    await rig.boot()
    const job = copyJob(rig)
    vi.mocked(replayJournal).mockClear()

    await runToEnd(rig, job)

    // The copy's publish wrote it as unsettled, and the copy settled it at once, replaying nothing.
    expect(replayJournal).not.toHaveBeenCalled()
    expect(
      isUnsettledJournalSessionStatus(readTestJournalSessionStatus(rig.root, 'session-cut')!)
    ).toBe(false)
    expect(readUnsettledJournalSessionIds(db(rig))).toEqual([])
    expect(rig.host.hasSession('session-cut')).toBe(false)
  })
})

describe('a missing status row (R2A-3)', () => {
  it('writes the row a closed chat a crash cut is missing, and settles it', async () => {
    const rig = await newRig()
    await crashMidSend(rig, 'session-closed', false)
    await createChats(rig, ['session-quiet'], { listed: false })
    await rig.crash()
    // The version 5 migration recreates the status table empty.
    db(rig).prepare('DELETE FROM journal_session_state').run()
    await rig.boot()
    expect(readUnsettledJournalSessionIds(db(rig))).toEqual([])

    await runToEnd(rig, copyJob(rig))

    for (const sessionId of ['session-closed', 'session-quiet']) {
      const status = readTestJournalSessionStatus(rig.root, sessionId)
      expect(status).not.toBeNull()
      expect(isUnsettledJournalSessionStatus(status!)).toBe(false)
    }
    // Settled through an open the copy closed again: never indexed, never published.
    expect(rig.host.hasSession('session-closed')).toBe(false)
    expect(
      rig.sink.publish.mock.calls.filter(([row]) => row.sessionId === 'session-closed')
    ).toEqual([])
  })

  it('leaves a chat that is open alone: its open writes its own row', async () => {
    const rig = await newRig()
    await createChats(rig, ['session-open'])
    db(rig).prepare('DELETE FROM journal_session_state').run()
    const job = copyJob(rig)

    await runToEnd(rig, job)

    expect(readTestJournalSessionStatus(rig.root, 'session-open')).toBeNull()
  })
})

describe('a restored chat still in its old file (T9)', () => {
  it('copies through the chat’s own owed import, adopting the copy’s fold with no replay', async () => {
    const rig = await newRig()
    await createChats(rig, ['session-restored'])
    await rig.crash()
    moveToPerChatFiles(rig, ['session-restored'])
    await rig.boot()
    expect(await startup(rig)).toEqual(['session-restored'])
    const journal = rig.host.collaboratorsForTests().sessions.get('session-restored')!.journal
    expect(journal.importPending).toBe(true)
    const before = journal.snapshot()
    vi.mocked(replayJournal).mockClear()

    await runToEnd(rig, copyJob(rig))

    expect(replayJournal).not.toHaveBeenCalled()
    expect(journal.importPending).toBe(false)
    expect(hasPerChatFile(rig, 'session-restored')).toBe(false)
    expect(journal.snapshot()).toEqual(before)
  })
})

describe('the same chat sent to while it copies (T8, regression guard)', () => {
  it('copies it once, and the send goes through', async () => {
    const rig = await newRig()
    await createChats(rig, ['session-busy'])
    await rig.crash()
    moveToPerChatFiles(rig, ['session-busy'])
    await rig.boot()

    const [sent] = await Promise.all([
      sendRestTestMessage(rig, 'session-busy', 'while it copies'),
      runToEnd(rig, copyJob(rig))
    ])

    expect(sent.ok).toBe(true)
    expect(db(rig).prepare('SELECT count(*) AS n FROM journal_imports').get()).toEqual({ n: 1 })
    expect(hasPerChatFile(rig, 'session-busy')).toBe(false)
  })
})

describe('starting and stopping (T17b, T6)', () => {
  it('starts one job however often startup runs, and its stop aborts every import first', async () => {
    const rig = await newRig()
    await createChats(rig, ['session-a'])
    await rig.crash()
    moveToPerChatFiles(rig, ['session-a'])
    const database = openTestJournalHostDatabase(rig.root)
    const intervals = vi.spyOn(globalThis, 'setInterval')
    const control = createStructuredAgentSessionPerChatFileCopyControl({
      database,
      store: rig.store,
      serialize: rig.host.collaboratorsForTests().serialize,
      openJournal: () => undefined,
      settleCopied: async () => undefined,
      isHostChatWorkActive: () => false,
      isDisposed: () => false,
      now: () => 0,
      appVersion: '1.0.0'
    })
    const start = { listedIds: ['session-a'], isRuntimeChatWorkActive: () => false }

    control.start(start)
    control.start(start)
    expect(intervals).toHaveBeenCalledOnce()

    await control.stop()
    expect(database.importsAborted).toBe(true)
    expect(hasPerChatFile(rig, 'session-a')).toBe(true)
  })
})
