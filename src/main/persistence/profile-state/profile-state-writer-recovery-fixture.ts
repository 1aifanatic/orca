import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, vi, type Mock } from 'vitest'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import { Store } from '../loading-store/store'
import { openProfileStateDatabaseReadOnly } from './profile-state-database'
import { readProfileStateRevisionOperation } from './profile-state-revision'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { ProfileStateWorkerAuthority } from './profile-state-worker-authority'

/** Per worker instance (0 = original, 1 = first replacement, ...). */
export type WriterFaultStep = {
  /** Never deliver the Nth write to SQLite: the command cannot have committed. */
  hangWrite?: number
  /** Commit the Nth write but lose its acknowledgement. */
  dropReplyOfWrite?: number
  /** Exit right after acknowledging the Nth write, leaving the writer idle and dead. */
  exitAfterWrite?: number
  /** Fail before the real worker entry runs. */
  failStart?: boolean
  /** Delay initialization so a test can act while a replacement is starting. */
  startDelayMs?: number
}

let bundleRoot: string
let entryPath: string
let backupWorkerPath: string
const roots: string[] = []
const cleanups: (() => Promise<unknown>)[] = []

beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'orca-writer-recovery-bundle-'))
  entryPath = join(bundleRoot, 'profile-state-writer-worker-entry.js')
  backupWorkerPath = join(bundleRoot, 'profile-state-backup-worker-entry.js')
  await build({
    entryPoints: [
      resolve('src/main/persistence/profile-state/profile-state-writer-worker-entry.ts'),
      resolve('src/main/persistence/profile-state/profile-state-backup-worker-entry.ts')
    ],
    outdir: bundleRoot,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup().catch(() => {})
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
})
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))

function faultWrapper(root: string): string {
  const path = join(root, 'fault-writer.cjs')
  writeFileSync(
    path,
    `
    const wt = require('node:worker_threads')
    const fs = require('node:fs')
    const path = require('node:path')
    const { dir, plan, replies } = wt.workerData.fault
    let instance = 0
    for (;; instance++) {
      try { fs.mkdirSync(path.join(dir, 'instance-' + instance)); break } catch {}
    }
    const step = plan[instance] || {}
    const log = (line) => fs.appendFileSync(path.join(dir, 'log'), instance + ':' + line + '\\n')
    if (step.failStart) process.exit(3)
    const port = wt.parentPort
    const on = port.on.bind(port)
    const post = port.postMessage.bind(port)
    const counter = replies ? new Int32Array(replies) : undefined
    let writes = 0
    let dropId
    let exitId
    port.on = (event, listener) => on(event, event !== 'message' ? listener : (value) => {
      log(value.command)
      if (value.command.startsWith('write-')) {
        writes++
        if (step.hangWrite === writes) return log('hung')
        if (step.dropReplyOfWrite === writes) dropId = value.id
        if (step.exitAfterWrite === writes) exitId = value.id
      }
      listener(value)
    })
    port.postMessage = (message) => {
      if (message.id === dropId) return log('dropped')
      post(message)
      if (counter) { Atomics.add(counter, 0, 1); Atomics.notify(counter, 0) }
      if (message.id === exitId) setImmediate(() => process.exit(1))
    }
    const start = () => require(${JSON.stringify(entryPath)})
    if (step.startDelayMs) setTimeout(start, step.startDelayMs)
    else start()
    `
  )
  return path
}

export async function createRecoveryFixture(
  plan: WriterFaultStep[],
  { timeoutMs = 1_500, withStore = false }: { timeoutMs?: number; withStore?: boolean } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-writer-recovery-'))
  roots.push(directory)
  const databaseFile = join(directory, 'profile-state.db')
  const profileId = 'recovery-test'
  const faultDir = join(directory, 'faults')
  const replies = new SharedArrayBuffer(4)
  const bootstrap = new ProfileStateSqliteAuthority(databaseFile, profileId)
  bootstrap.writeSerializedState(
    Buffer.from(JSON.stringify(buildProfileStateCutoverFixture(directory)))
  )
  const state = bootstrap.readInitialState().takeParsedState?.()
  const onFailure: Mock<(error: Error) => void> = vi.fn()
  mkdirSync(faultDir)
  // Extra workerData read only by the fault wrapper; replacements inherit it.
  const initialization = { ...bootstrap.retireForWorker(), fault: { dir: faultDir, plan, replies } }
  const authority = new ProfileStateWorkerAuthority(initialization, {
    workerPath: faultWrapper(directory),
    backupWorkerPath,
    timeoutMs,
    onFailure
  })
  // Rotation is out of scope here.
  vi.spyOn(authority, 'scheduleBackup').mockImplementation(() => {})
  cleanups.push(() => authority.close())
  await authority.ready
  const store = withStore
    ? new Store({
        dataFile: join(directory, 'orca-data.json'),
        profileStateAuthority: authority,
        initialAuthorityState: { authority, takeParsedState: () => state }
      })
    : undefined
  if (store) {
    cleanups.unshift(() => store.freezeWritesAsync())
  }
  const counter = new Int32Array(replies)
  return {
    authority,
    store,
    onFailure,
    databaseFile,
    profileId,
    peer: () => new ProfileStateSqliteAuthority(databaseFile, profileId),
    readMeta: () => {
      const opened = openProfileStateDatabaseReadOnly(databaseFile, profileId)
      try {
        return readProfileStateRevisionOperation(opened.db)
      } finally {
        opened.db.close()
      }
    },
    readState: () => {
      const reader = new ProfileStateSqliteAuthority(databaseFile, profileId)
      try {
        return JSON.parse(reader.readSerializedState() ?? '{}')
      } finally {
        reader.close()
      }
    },
    instances: () => readdirSync(faultDir).filter((name) => name.startsWith('instance-')).length,
    log: () => {
      try {
        return readFileSync(join(faultDir, 'log'), 'utf8').trim().split('\n')
      } catch {
        return []
      }
    },
    awaitQueuedReplies: (count: number) => {
      while (Atomics.load(counter, 0) < count) {
        Atomics.wait(counter, 0, Atomics.load(counter, 0), 5_000)
      }
    }
  }
}
