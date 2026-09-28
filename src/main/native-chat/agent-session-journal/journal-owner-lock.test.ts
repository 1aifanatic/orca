// The owner lock: one process per state directory opens the chat journal.

import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sweepOrphanedRuntimeSockets } from '../../runtime/runtime-rpc/runtime-rpc-socket-metadata'
import { copyProfileStateRecoveryFile } from '../../persistence/profile-state/profile-state-recovery-copy'
import { JournalHostDatabase, journalDatabasePath } from './journal-host-database'
import {
  JOURNAL_OWNER_LOCK_FILE,
  retryJournalOwnerLock,
  tryAcquireJournalOwnerLock,
  type JournalOwnerLock
} from './journal-owner-lock'
import {
  holdJournalOwnerLockInChild,
  probeJournalOwnerLockInChild,
  type JournalOwnerLockHolder
} from './journal-owner-lock-test-support'

let root: string
let holder: JournalOwnerLockHolder | null = null
const locks: JournalOwnerLock[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-owner-'))
})

afterEach(async () => {
  await holder?.kill()
  holder = null
  for (const lock of locks.splice(0)) {
    lock.release()
  }
  await rm(root, { recursive: true, force: true })
})

function acquire(): JournalOwnerLock | null {
  const lock = tryAcquireJournalOwnerLock(root)
  if (lock) {
    locks.push(lock)
  }
  return lock
}

describe('the owner lock', () => {
  // T-B1: a second process is refused, never opens the database, and takes over once the owner
  // dies — with no stale lock to clean up.
  it('refuses a second process until the owner dies, then grants it at once', async () => {
    holder = await holdJournalOwnerLockInChild(root)

    expect(acquire()).toBeNull()
    expect(existsSync(journalDatabasePath(root))).toBe(false)

    await holder.kill()
    holder = null
    const lock = acquire()
    expect(lock?.isHeld).toBe(true)
    // The owner can now open the one database; nobody could before.
    JournalHostDatabase.open(lock!).close()
  })

  it('keeps the lock file empty and never grows it a write-ahead log', async () => {
    const lock = acquire()
    expect(lock).not.toBeNull()
    const path = join(root, JOURNAL_OWNER_LOCK_FILE)
    expect((await stat(path)).size).toBe(0)
    expect(await readdir(root)).not.toContain(`${JOURNAL_OWNER_LOCK_FILE}-wal`)
    expect(await probeJournalOwnerLockInChild(root)).toBe('refused')
  })

  it('opens the database only under a lock it still holds', () => {
    const lock = acquire()!
    lock.release()
    expect(() => JournalHostDatabase.open(lock)).toThrow('owner lock')
    expect(existsSync(journalDatabasePath(root))).toBe(false)
  })

  // T-owner-copy (N-R1): a POSIX close of ANY descriptor on the lock's inode drops the whole
  // process's lock. These two run in the owner's state directory; neither may drop it.
  it('stays held through the runtime socket sweep and the profile-state recovery copy', async () => {
    expect(acquire()).not.toBeNull()
    await writeFile(join(root, 'o-999999-stale.sock'), '')
    await writeFile(join(root, 'orca-data.json'), '{}')

    sweepOrphanedRuntimeSockets(root, process.pid)
    copyProfileStateRecoveryFile(join(root, 'orca-data.json'), join(root, 'orca-data.json.copy'))

    expect(await probeJournalOwnerLockInChild(root)).toBe('refused')
  })
})

describe('retrying a refused lock', () => {
  it('backs off from one second to thirty and stops once it is granted', () => {
    const delays: number[] = []
    const pending: (() => void)[] = []
    let grantOn = 7
    const granted: JournalOwnerLock[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the retry only hands the value it was given to `onAcquired`.
    const fakeLock = { isHeld: true } as unknown as JournalOwnerLock
    retryJournalOwnerLock({
      stateDirectory: root,
      acquire: () => (--grantOn === 0 ? fakeLock : null),
      onAcquired: (lock) => granted.push(lock),
      schedule: (run, delayMs) => {
        delays.push(delayMs)
        pending.push(run)
        return { cancel: () => undefined }
      }
    })
    while (pending.length > 0) {
      pending.shift()!()
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
    expect(granted).toEqual([fakeLock])
  })

  it('dies when cancelled', () => {
    const pending: (() => void)[] = []
    let attempts = 0
    const retry = retryJournalOwnerLock({
      stateDirectory: root,
      acquire: () => {
        attempts += 1
        return null
      },
      onAcquired: () => undefined,
      schedule: (run) => {
        pending.push(run)
        return { cancel: () => pending.splice(0) }
      }
    })
    retry.cancel()
    expect(pending).toEqual([])
    expect(attempts).toBe(0)
  })
})
