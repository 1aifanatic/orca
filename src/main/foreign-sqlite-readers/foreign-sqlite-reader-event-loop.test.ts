import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import SyncDatabase from '../sqlite/sync-database'
import { ForeignSqliteReaderClient } from './foreign-sqlite-reader-client'

// Why: the reported freeze is a sole opener rebuilding the WAL index of a huge
// un-checkpointed -wal. The fixture reproduces that shape at CI size; a small
// page size multiplies the frames per MB so tens of MB block measurably.
//
// Both arms read identical copies and are compared against each other, not a
// fixed threshold: the inline arm (the pre-worker main-thread read) establishes
// how long the open blocks, and the worker arm must leave the calling thread's
// timer on time and its event loop mostly idle meanwhile.

const PAGE_SIZE = 512
const TRANSACTIONS = 2_400
const ROWS_PER_TRANSACTION = 5
const MIN_WAL_BYTES = 40_000_000
const TOKEN = 'event-loop-token'
const TIMER_INTERVAL_MS = 5

let root = ''
let workerEntryPath = ''

function stateDbPath(name: string): string {
  return join(root, `${name}.vscdb`)
}

/**
 * Leave a WAL with no -shm beside it. A read-only connection that closes last
 * cannot checkpoint, so the writer's frames stay in the -wal; deleting the -shm
 * then forces the next opener to rebuild the index from every frame.
 */
function writeLargeWalFixture(): void {
  const path = stateDbPath('worker')
  const writer = new SyncDatabase(path)
  writer.exec(`PRAGMA page_size = ${PAGE_SIZE}`)
  writer.exec('PRAGMA journal_mode = WAL')
  writer.exec('PRAGMA wal_autocheckpoint = 0')
  writer.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
  const insert = writer.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
  insert.run('cursorAuth/accessToken', TOKEN)
  const padding = new Uint8Array(4_000).fill(7)
  for (let tx = 0; tx < TRANSACTIONS; tx++) {
    writer.exec('BEGIN')
    for (let row = 0; row < ROWS_PER_TRANSACTION; row++) {
      insert.run(`padding/${tx}/${row}`, padding)
    }
    writer.exec('COMMIT')
  }
  const holder = new SyncDatabase(path, { readonly: true })
  holder.prepare('SELECT count(*) AS n FROM ItemTable').get()
  writer.close()
  holder.close()
  rmSync(`${path}-shm`, { force: true })
  copyFileSync(path, stateDbPath('inline'))
  copyFileSync(`${path}-wal`, `${stateDbPath('inline')}-wal`)
}

function readTokenInline(path: string): string | null {
  const db = new SyncDatabase(path, { readonly: true, fileMustExist: true, timeout: 250 })
  try {
    const row = db
      .prepare('SELECT value FROM ItemTable WHERE key = ?')
      .get('cursorAuth/accessToken')
    return typeof row?.value === 'string' ? row.value : null
  } finally {
    db.close()
  }
}

type Measured<T> = { value: T; activeMs: number; wallMs: number; maxTimerLatenessMs: number }

/** Run `fn` while a main-thread timer ticks, recording its worst lateness. */
async function measure<T>(fn: () => Promise<T>): Promise<Measured<T>> {
  let maxTimerLatenessMs = 0
  let expectedAt = performance.now() + TIMER_INTERVAL_MS
  let timer: NodeJS.Timeout | null = null
  const tick = (): void => {
    const now = performance.now()
    maxTimerLatenessMs = Math.max(maxTimerLatenessMs, now - expectedAt)
    expectedAt = now + TIMER_INTERVAL_MS
    timer = setTimeout(tick, TIMER_INTERVAL_MS)
  }
  timer = setTimeout(tick, TIMER_INTERVAL_MS)
  // Let the timer arm before the read starts, so an inline block is seen as lateness.
  await new Promise((done) => setTimeout(done, TIMER_INTERVAL_MS * 2))
  const before = performance.eventLoopUtilization()
  const startedAt = performance.now()
  const value = await fn()
  // One more tick so a block that ended just now is observed.
  await new Promise((done) => setTimeout(done, TIMER_INTERVAL_MS * 2))
  const wallMs = performance.now() - startedAt
  const activeMs = performance.eventLoopUtilization(before).active
  if (timer) {
    clearTimeout(timer)
  }
  return { value, activeMs, wallMs, maxTimerLatenessMs }
}

function describeArm(label: string, arm: Measured<unknown>): string {
  return `${label}: active ${arm.activeMs.toFixed(1)}ms, wall ${arm.wallMs.toFixed(1)}ms, worst timer lateness ${arm.maxTimerLatenessMs.toFixed(1)}ms`
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-foreign-sqlite-event-loop-'))
  writeLargeWalFixture()
  workerEntryPath = join(root, 'foreign-sqlite-reader-entry.cjs')
  // Why bundle here: `new Worker` needs JavaScript, and the production entry is
  // emitted by the app build. Bundling the same source runs the real reader.
  await build({
    entryPoints: [resolve(__dirname, 'foreign-sqlite-reader-entry.ts')],
    outfile: workerEntryPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    logLevel: 'error'
  })
}, 120_000)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('foreign SQLite reader event-loop occupancy', () => {
  it('keeps the calling thread responsive while a large-WAL open blocks the worker', async () => {
    // Presence precondition: a fixture whose WAL was checkpointed away would make both arms fast.
    expect(statSync(`${stateDbPath('worker')}-wal`).size).toBeGreaterThan(MIN_WAL_BYTES)
    expect(statSync(`${stateDbPath('inline')}-wal`).size).toBeGreaterThan(MIN_WAL_BYTES)

    const client = new ForeignSqliteReaderClient({
      workerFactory: () => new Worker(workerEntryPath),
      log: () => {}
    })
    try {
      // Warm the thread first so the measured arm is the read, not the spawn.
      await expect(client.readCursorProfile(join(root, 'absent.vscdb'))).resolves.toEqual({
        status: 'missing'
      })
      const worker = await measure(() => client.readCursorProfile(stateDbPath('worker')))
      expect(worker.value).toMatchObject({ status: 'ok', profile: { accessToken: TOKEN } })

      const inline = await measure(async () => readTokenInline(stateDbPath('inline')))
      expect(inline.value).toBe(TOKEN)

      const report = `${describeArm('worker', worker)}; ${describeArm('inline', inline)}`
      // The worker arm waited on the open, so it took about as long as the inline one.
      expect(worker.wallMs, report).toBeGreaterThan(inline.activeMs / 4)
      expect(worker.activeMs, report).toBeLessThan(inline.activeMs / 5)
      expect(worker.maxTimerLatenessMs, report).toBeLessThan(inline.maxTimerLatenessMs / 2)
    } finally {
      client.dispose()
    }
  }, 120_000)

  it('answers the Go key and Codex index readers from the bundled worker', async () => {
    const credentialDb = join(root, 'opencode.db')
    const credentials = new SyncDatabase(credentialDb)
    credentials.exec(
      'CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, value TEXT, ' +
        'active INTEGER, time_created INTEGER)'
    )
    credentials
      .prepare("INSERT INTO credential VALUES ('c', 'opencode-go', ?, 1, 1)")
      .run(JSON.stringify({ type: 'key', key: 'placeholder-key' }))
    credentials.close()
    const codexHome = join(root, 'codex-home')
    mkdirSync(codexHome)
    const state = new SyncDatabase(join(codexHome, 'state_5.sqlite'))
    state.exec(
      'CREATE TABLE backfill_state (id INTEGER PRIMARY KEY, status TEXT NOT NULL); ' +
        "INSERT INTO backfill_state (id, status) VALUES (1, 'running')"
    )
    state.close()

    const client = new ForeignSqliteReaderClient({
      workerFactory: () => new Worker(workerEntryPath),
      log: () => {}
    })
    try {
      await expect(client.readOpenCodeGoKey([credentialDb])).resolves.toEqual({
        status: 'found',
        key: 'placeholder-key'
      })
      await expect(
        client.readCodexIndexStatus({
          type: 'backfill',
          codexHomePath: codexHome,
          sessionFileLimit: 100
        })
      ).resolves.toEqual({
        type: 'backfill',
        status: {
          kind: 'incomplete',
          stateDbPath: join(codexHome, 'state_5.sqlite'),
          status: 'running'
        },
        sessionFileCount: null
      })
    } finally {
      client.dispose()
    }
  }, 60_000)

  it('keeps a short-lived process alive until its read answers', async () => {
    // Why: the worker is unref'd; a CLI awaiting a read with nothing else alive must not exit early.
    const scriptPath = join(root, 'short-lived-reader.cjs')
    await build({
      stdin: {
        contents: [
          "import { Worker } from 'node:worker_threads'",
          "import { ForeignSqliteReaderClient } from './foreign-sqlite-reader-client'",
          'const client = new ForeignSqliteReaderClient({',
          '  workerFactory: () => new Worker(process.argv[2]),',
          '  log: () => {}',
          '})',
          'void client',
          "  .readCodexIndexStatus({ type: 'sessionFileCount', sessionsRoot: process.argv[3], limit: 1 })",
          '  .then((answer) => console.log(JSON.stringify(answer)))'
        ].join('\n'),
        resolveDir: __dirname,
        loader: 'ts'
      },
      outfile: scriptPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      logLevel: 'error'
    })
    const { stdout } = await promisify(execFile)(process.execPath, [
      scriptPath,
      workerEntryPath,
      root
    ])
    expect(JSON.parse(stdout)).toEqual({ type: 'sessionFileCount', count: 0 })
  }, 60_000)
})
