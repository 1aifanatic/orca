// The background copy of old per-chat files: a fixed budget per run, a gate re-derived before every
// run and every chat, listed chats first, a disk guard, a give-up keyed to the file, and an end.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { NO_LEGACY_JOURNAL_RECORDS } from '../agent-session-journal/journal-database'
import { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { writePerChatJournalFile } from '../agent-session-journal/journal-per-chat-file-test-support'
import {
  legacyJournalDatabaseFile,
  perChatJournalRoot
} from '../agent-session-journal/journal-paths'
import {
  importPerSessionJournal,
  type PerSessionJournalImport
} from '../agent-session-journal/journal-per-session-import'
import {
  PER_CHAT_FILE_COPY_DISK_RETRY_MS,
  PER_CHAT_FILE_COPY_INTERVAL_MS
} from './structured-agent-session-per-chat-file-copy'
import { startStructuredAgentSessionPerChatFileCopy } from './structured-agent-session-per-chat-file-copy-control'
import {
  COPY_TEST_WORKSPACE,
  copyJob,
  createChats,
  createCopyTestRig,
  hasPerChatFile,
  moveToPerChatFiles,
  runToEnd,
  writeStubPerChatFile,
  type CopyTestRig
} from './structured-agent-session-per-chat-file-copy-test-rig'

const rigs: CopyTestRig[] = []
const scratch: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  closeTestJournalHostDatabases()
  for (const directory of scratch.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function newRig(): Promise<CopyTestRig> {
  const rig = await createCopyTestRig()
  rigs.push(rig)
  return rig
}

const ids = (count: number, prefix = 'session') =>
  Array.from({ length: count }, (_, index) => `${prefix}-${index}`)

/** Records for `count` chats, each with a stub per-chat file only a fake importer reads. */
async function stubChats(rig: CopyTestRig, count: number, listed = false): Promise<string[]> {
  const sessionIds = ids(count)
  await createChats(rig, sessionIds, { listed, message: false })
  for (const sessionId of sessionIds) {
    writeStubPerChatFile(rig, sessionId)
  }
  return sessionIds
}

/** A fake importer that costs `costMs` of the job's clock per chat. */
function costlyImport(rig: CopyTestRig, costMs: number) {
  return vi.fn(async (_input: Parameters<typeof importPerSessionJournal>[0]) => {
    rig.copyClock.now += costMs
    return { outcome: 'imported' as const }
  })
}

/** The real importer, counted. */
function countedImport() {
  return vi.fn((input: Parameters<typeof importPerSessionJournal>[0]) =>
    importPerSessionJournal(input)
  )
}

describe('a fixed budget per run (T2)', () => {
  it('starts no chat after 200 ms of a run, and none past the 8th', async () => {
    const rig = await newRig()
    await stubChats(rig, 12)
    const slow = costlyImport(rig, 60)
    const job = copyJob(rig, { importJournal: slow })

    await job.tick()
    // 0, 60, 120 and 180 ms are under the budget; the run ends at 240.
    expect(slow).toHaveBeenCalledTimes(4)

    const fast = costlyImport(rig, 1)
    const capped = copyJob(rig, { importJournal: fast })
    await capped.tick()
    expect(fast).toHaveBeenCalledTimes(8)
  })

  it('skips a tick while a run is still going, and ticks a second apart', async () => {
    const rig = await newRig()
    await stubChats(rig, 3)
    const release = Promise.withResolvers<void>()
    const held = vi.fn(async () => {
      await release.promise
      return { outcome: 'imported' as const }
    })
    const job = copyJob(rig, { importJournal: held })

    const first = job.tick()
    await vi.waitFor(() => expect(held).toHaveBeenCalledOnce())
    await job.tick()
    release.resolve()
    await first
    expect(held).toHaveBeenCalledTimes(3)

    const interval = vi.spyOn(globalThis, 'setInterval')
    job.start()
    expect(interval).toHaveBeenCalledWith(expect.any(Function), PER_CHAT_FILE_COPY_INTERVAL_MS)
    await job.stop()
  })
})

describe('waiting for startup chat work (T16)', () => {
  it('runs nothing in the first 10 s, and runs then when nothing else is in flight', async () => {
    const rig = await newRig()
    await stubChats(rig, 1)
    const fake = costlyImport(rig, 1)
    const job = copyJob(rig, { importJournal: fake, startDelayMs: undefined })

    rig.copyClock.now = 9_999
    await job.tick()
    expect(fake).not.toHaveBeenCalled()
    // An orcad-style host no client has listed yet: nothing gates it once the floor passes.
    rig.copyClock.now = 10_000
    await job.tick()
    expect(fake).toHaveBeenCalledOnce()
  })

  it('starts no run while startup chat work is in flight', async () => {
    const rig = await newRig()
    await stubChats(rig, 2)
    const fake = costlyImport(rig, 1)
    let active = true
    const job = copyJob(rig, { importJournal: fake, isStartupChatWorkActive: () => active })

    await job.tick()
    expect(fake).not.toHaveBeenCalled()
    active = false
    await job.tick()
    expect(fake).toHaveBeenCalledTimes(2)
  })

  it('pauses after the chat in hand when a listing starts mid-run', async () => {
    const rig = await newRig()
    await stubChats(rig, 5)
    let listing = false
    const fake = vi.fn(async () => {
      // A late client lists its tabs while this chat copies.
      listing = true
      return { outcome: 'imported' as const }
    })
    const job = copyJob(rig, { importJournal: fake, isStartupChatWorkActive: () => listing })

    await job.tick()
    expect(fake).toHaveBeenCalledOnce()
    listing = false
    await job.tick()
    expect(fake).toHaveBeenCalledTimes(2)
  })
})

describe('order (T15)', () => {
  it('copies listed chats first, in tab order, then the rest', async () => {
    const rig = await newRig()
    const unlisted = await stubChats(rig, 3)
    await createChats(rig, ['listed-b', 'listed-a'], { message: false })
    for (const sessionId of ['listed-b', 'listed-a']) {
      writeStubPerChatFile(rig, sessionId)
    }
    const fake = costlyImport(rig, 1)
    const job = copyJob(rig, { importJournal: fake })

    await runToEnd(rig, job)

    const order = fake.mock.calls.map(([input]) => input.identity.sessionId)
    expect(order.slice(0, 2)).toEqual(['listed-b', 'listed-a'])
    expect(order.slice(2).toSorted()).toEqual(unlisted)
  })
})

describe('the disk guard (T12)', () => {
  it('starts no chat below the free-space floor, probes again only after 60 s, then copies', async () => {
    const rig = await newRig()
    await stubChats(rig, 1)
    const fake = costlyImport(rig, 1)
    let free = 100 * 1024 * 1024
    const freeBytes = vi.fn(async () => free)
    const job = copyJob(rig, { importJournal: fake, freeBytes })

    await job.tick()
    expect(fake).not.toHaveBeenCalled()
    expect(freeBytes).toHaveBeenCalledOnce()
    rig.copyClock.now += 1_000
    await job.tick()
    expect(freeBytes).toHaveBeenCalledOnce()

    free = 8 * 1024 * 1024 * 1024
    rig.copyClock.now += PER_CHAT_FILE_COPY_DISK_RETRY_MS
    await job.tick()
    expect(fake).toHaveBeenCalledOnce()
  })
})

describe('what the job never touches (T13, T14, T18)', () => {
  it('never opens or deletes a file no chat record names, nor an older build’s recovery copy', async () => {
    const rig = await newRig()
    await createChats(rig, ['session-real'])
    await rig.crash()
    moveToPerChatFiles(rig, ['session-real'])
    const database = openTestJournalHostDatabase(rig.root)
    const orphan = writePerChatJournalFile(
      database.legacyDirectoryFor({ sessionId: 'deleted-chat', workspaceId: COPY_TEST_WORKSPACE }),
      'deleted-chat',
      { epoch: 'orphan', rows: [] }
    )
    const recovered = writePerChatJournalFile(
      `${database.legacyDirectoryFor({ sessionId: 'session-real', workspaceId: COPY_TEST_WORKSPACE })}-recovered-v3`,
      'session-real',
      { epoch: 'recovered', rows: [] }
    )
    const counted = countedImport()

    await runToEnd(rig, copyJob(rig, { importJournal: counted }))

    expect(counted.mock.calls.map(([input]) => input.identity.sessionId)).toEqual(['session-real'])
    expect(existsSync(orphan)).toBe(true)
    expect(existsSync(recovered)).toBe(true)
    expect(hasPerChatFile(rig, 'session-real')).toBe(false)
  })

  it('never starts while the records file is still owed, or on a newer build’s database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-copy-start-'))
    scratch.push(directory)
    await mkdir(perChatJournalRoot(directory), { recursive: true })
    const deps = (database: JournalHostDatabase) => ({
      ...copyJobDeps,
      database
    })

    const owed = JournalHostDatabase.openWith(directory, { owed: true })
    expect(owed.legacyRecordImportOwed).toBe(true)
    expect(startStructuredAgentSessionPerChatFileCopy(deps(owed))).toBeNull()
    owed.close()

    const newer = new Database(join(directory, 'agent-session-journal.db'))
    newer.pragma('user_version = 99')
    newer.close()
    const readOnly = JournalHostDatabase.openWith(directory, NO_LEGACY_JOURNAL_RECORDS)
    expect(readOnly.readOnly).toBe(true)
    expect(startStructuredAgentSessionPerChatFileCopy(deps(readOnly))).toBeNull()
    readOnly.close()
  })

  it('never calls the importer for a set-aside file, and still ends', async () => {
    const rig = await newRig()
    await stubChats(rig, 1)
    openTestJournalHostDatabase(rig.root)
      .db.prepare('INSERT INTO journal_set_aside (session_id, epoch, tip) VALUES (?, ?, ?)')
      .run('session-0', 'stub', 0)
    const counted = countedImport()
    const job = copyJob(rig, { importJournal: counted })

    await runToEnd(rig, job)

    expect(counted).not.toHaveBeenCalled()
    expect(hasPerChatFile(rig, 'session-0')).toBe(true)
  })
})

/** A job's dependencies that `startStructuredAgentSessionPerChatFileCopy` never reaches when it
 *  refuses to start. */
const copyJobDeps = {
  store: { getRecord: () => null, listRecords: () => [] },
  listedIds: [],
  isStartupChatWorkActive: () => false,
  serialize: <T>(_sessionId: string, task: () => Promise<T>) => task(),
  openJournal: () => undefined,
  settleCopied: async () => undefined,
  isDisposed: () => false,
  now: () => 0,
  appVersion: '1.0.0'
}

describe('a copy that fails (T10, T11)', () => {
  it('records a file that will not open, skips it while it stays the same, and tries a changed one once', async () => {
    const rig = await newRig()
    await createChats(rig, ['session-broken'], { message: false })
    const directory = openTestJournalHostDatabase(rig.root).legacyDirectoryFor({
      sessionId: 'session-broken',
      workspaceId: COPY_TEST_WORKSPACE
    })
    await mkdir(directory, { recursive: true })
    const file = legacyJournalDatabaseFile(directory)
    await writeFile(file, 'not a database '.repeat(512))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const counted = countedImport()

    await runToEnd(rig, copyJob(rig, { importJournal: counted }))
    expect(counted).toHaveBeenCalledOnce()
    expect(
      openTestJournalHostDatabase(rig.root)
        .db.prepare('SELECT db_size, app_version FROM journal_copy_failures WHERE session_id = ?')
        .get('session-broken')
    ).toEqual({ db_size: 'not a database '.repeat(512).length, app_version: '1.0.0' })

    // The next launch, same file and version: not tried.
    await runToEnd(rig, copyJob(rig, { importJournal: counted }))
    expect(counted).toHaveBeenCalledOnce()
    // A new version tries it once more.
    await runToEnd(rig, copyJob(rig, { importJournal: counted, appVersion: '1.0.1' }))
    expect(counted).toHaveBeenCalledTimes(2)
    // So does a file that moved since.
    await utimes(file, new Date(), new Date(Date.now() + 60_000))
    await runToEnd(rig, copyJob(rig, { importJournal: counted, appVersion: '1.0.1' }))
    expect(counted).toHaveBeenCalledTimes(3)
    expect(existsSync(file)).toBe(true)
  })

  it('tries a transient failure at most three times a launch, records nothing, and keeps the file', async () => {
    const rig = await newRig()
    await stubChats(rig, 1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const full = vi.fn(async (): Promise<PerSessionJournalImport> => {
      throw Object.assign(new Error('database or disk is full'), {
        code: 'ERR_SQLITE_ERROR',
        errcode: 13
      })
    })

    await runToEnd(rig, copyJob(rig, { importJournal: full }))

    expect(full).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledOnce()
    expect(
      openTestJournalHostDatabase(rig.root)
        .db.prepare('SELECT count(*) AS n FROM journal_copy_failures')
        .get()
    ).toEqual({ n: 0 })
    expect(hasPerChatFile(rig, 'session-0')).toBe(true)
  })
})

describe('the end (T17)', () => {
  it('stops its timer, removes the emptied directories, and the next launch starts nothing', async () => {
    const rig = await newRig()
    const sessionIds = ids(3)
    await createChats(rig, sessionIds)
    await rig.crash()
    moveToPerChatFiles(rig, sessionIds)
    const clear = vi.spyOn(globalThis, 'clearInterval')
    const job = copyJob(rig)
    job.start()

    await runToEnd(rig, job)

    expect(clear).toHaveBeenCalled()
    expect(existsSync(perChatJournalRoot(rig.root))).toBe(false)
    expect(
      startStructuredAgentSessionPerChatFileCopy({
        ...copyJobDeps,
        database: openTestJournalHostDatabase(rig.root)
      })
    ).toBeNull()
  })
})
