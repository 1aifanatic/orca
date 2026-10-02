import { EventEmitter } from 'node:events'
import { readdirSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForeignSqliteReaderRequest } from '../foreign-sqlite-readers/foreign-sqlite-reader-protocol'
import { _internals as readerInternals } from '../foreign-sqlite-readers/foreign-sqlite-reader-spawn'
import {
  _internals as recoveryInternals,
  startCodexStateDbBackfillRecoveryInBackground
} from './codex-state-db-backfill-recovery'
import {
  countCodexSessionFilesUpTo,
  isCodexStateDbBackfillPending,
  readIndexedCodexThreadIds
} from './codex-state-db'

// Any main-thread touch of the share, through any fs entry point, is recorded here.
const fsTouches = vi.hoisted((): string[] => [])
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>() // eslint-disable-line @typescript-eslint/consistent-type-imports -- importOriginal needs an inline type
  const record =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      fsTouches.push(String(args[0]))
      return fn(...args)
    }
  return {
    ...actual,
    default: actual,
    readdirSync: record(actual.readdirSync),
    existsSync: record(actual.existsSync),
    statSync: record(actual.statSync)
  }
})
vi.mock('../sqlite/sync-database', () => ({
  default: class {
    constructor(path: string) {
      fsTouches.push(String(path))
      throw new Error('main-thread SQLite open')
    }
  }
}))

const WSL_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex'
const originalPlatform = process.platform

class RecordingWorker extends EventEmitter {
  posted: ForeignSqliteReaderRequest[] = []
  postMessage(request: ForeignSqliteReaderRequest): void {
    this.posted.push(request)
  }
  unref(): void {}
  async terminate(): Promise<number> {
    return 1
  }
  reply(value: unknown): void {
    const last = this.posted.at(-1)
    this.emit('message', { id: last?.id, ok: true, value })
  }
}

let worker: RecordingWorker

async function nextPost(count: number): Promise<void> {
  await vi.waitFor(() => expect(worker.posted).toHaveLength(count))
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  fsTouches.length = 0
  worker = new RecordingWorker()
  readerInternals.setWorkerFactory(() => worker)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  readerInternals.setWorkerFactory(null)
  recoveryInternals.resetForTests()
})

describe('a \\\\wsl.localhost Codex home on Windows', () => {
  it('records main-thread fs reads (precondition for the absence checks below)', () => {
    readdirSync(__dirname)
    expect(fsTouches).toEqual([__dirname])
  })

  it('is read on the reader worker, never over the share on the main thread', async () => {
    const pending = isCodexStateDbBackfillPending(WSL_HOME)
    await nextPost(1)
    expect(worker.posted[0]).toMatchObject({
      kind: 'codexIndexStatus',
      query: { type: 'backfill', codexHomePath: WSL_HOME, sessionFileLimit: 100 }
    })
    worker.reply({
      type: 'backfill',
      status: { kind: 'incomplete', stateDbPath: `${WSL_HOME}\\state_5.sqlite`, status: 'running' },
      sessionFileCount: null
    })
    await expect(pending).resolves.toBe(true)

    const ids = readIndexedCodexThreadIds(WSL_HOME)
    await nextPost(2)
    expect(worker.posted[1]).toMatchObject({
      query: { type: 'indexedThreadIds', codexHomePath: WSL_HOME }
    })
    worker.reply({ type: 'indexedThreadIds', threadIds: ['abc'], error: null })
    await expect(ids).resolves.toEqual(new Set(['abc']))

    const count = countCodexSessionFilesUpTo(`${WSL_HOME}\\sessions`, 1)
    await nextPost(3)
    worker.reply({ type: 'sessionFileCount', count: 1 })
    await expect(count).resolves.toBe(1)

    expect(fsTouches.filter((path) => path.startsWith('\\\\wsl'))).toEqual([])
  })

  it('arbitrates backfill recovery through the worker read', async () => {
    let lockClaims = 0
    const task = startCodexStateDbBackfillRecoveryInBackground(WSL_HOME, {
      run: vi.fn(),
      withLock: async () => {
        lockClaims += 1
        throw new Error('a complete index takes no lock')
      }
    })
    await nextPost(1)
    expect(worker.posted[0]).toMatchObject({ query: { codexHomePath: WSL_HOME } })
    worker.reply({
      type: 'backfill',
      status: { kind: 'complete', stateDbPath: `${WSL_HOME}\\state_5.sqlite` },
      sessionFileCount: null
    })
    await expect(task).resolves.toBeNull()
    expect(lockClaims).toBe(0)
    expect(fsTouches.filter((path) => path.startsWith('\\\\wsl'))).toEqual([])
  })
})
