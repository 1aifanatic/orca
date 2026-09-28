// Another process on the same state directory, for tests of the owner lock. The lock is a kernel
// lock held per process, so only a real second process can stand in for a second Orca.

import { join } from 'node:path'
import { runProcess, spawnProcess } from '../../../shared/child-process/run-process'
import { JOURNAL_OWNER_LOCK_FILE } from './journal-owner-lock'

const HOLD_SCRIPT = `
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.argv[1], { timeout: 0 })
db.exec('BEGIN EXCLUSIVE')
process.stdout.write('held\\n')
setInterval(() => {}, 1000)
`

const PROBE_SCRIPT = `
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.argv[1], { timeout: 0 })
try {
  db.exec('BEGIN EXCLUSIVE')
  process.stdout.write('acquired')
} catch {
  process.stdout.write('refused')
}
`

export type JournalOwnerLockHolder = {
  pid: number
  /** SIGKILL, the way a crashed Orca dies; resolves once the process is gone. */
  kill: () => Promise<void>
}

/** A second process holding the state directory's owner lock until it is killed. */
export async function holdJournalOwnerLockInChild(
  stateDirectory: string
): Promise<JournalOwnerLockHolder> {
  const child = spawnProcess({
    program: process.execPath,
    args: ['-e', HOLD_SCRIPT, join(stateDirectory, JOURNAL_OWNER_LOCK_FILE)],
    // Bounded: a test that never kills it still does not leave it running.
    timeoutMs: 60_000
  })
  const pid = child.pid
  if (pid === undefined) {
    throw new Error('the lock holder did not start')
  }
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  await new Promise<void>((resolve, reject) => {
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.includes('held')) {
        resolve()
      }
    })
    child.once('exit', (code) => reject(new Error(`the lock holder exited early (${code})`)))
  })
  return {
    pid,
    kill: async () => {
      // Only the process this helper started, by its own handle.
      child.kill('SIGKILL')
      await exited
    }
  }
}

/** Whether a separate process could take the owner lock right now. It releases it at once. */
export async function probeJournalOwnerLockInChild(
  stateDirectory: string
): Promise<'acquired' | 'refused'> {
  const result = await runProcess({
    program: process.execPath,
    args: ['-e', PROBE_SCRIPT, join(stateDirectory, JOURNAL_OWNER_LOCK_FILE)],
    timeoutMs: 30_000
  })
  if (result.stdout === 'acquired' || result.stdout === 'refused') {
    return result.stdout
  }
  throw new Error(`the lock probe failed: ${result.stderr}`)
}
