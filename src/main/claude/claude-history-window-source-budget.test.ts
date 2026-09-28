// The streaming contract the history window now reads under: one bounded pass
// over ONE pinned snapshot, and no whole-file buffer at any point. The previous
// contract was a single bounded read, which made an oversized transcript report
// an inconsistent boundary — that answer left reconciliation permanently
// unresolved for a session whose transcript simply grew, so what is asserted
// here is the opposite: it resolves, and it never holds the file.

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { FileHandle } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  path: '',
  growth: '',
  readError: false,
  bytesRead: 0,
  /** Largest single chunk handed to the framer across every pass. */
  peakChunkBytes: 0,
  streams: 0,
  closes: 0,
  opens: 0,
  observedStatBytes: 0
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  return {
    ...fs,
    open: async (path: string, flags: string) => {
      const handle = await fs.open(path, flags)
      if (path !== state.path) {
        return handle
      }
      state.opens += 1
      return {
        stat: async (options?: Parameters<FileHandle['stat']>[0]) => {
          const snapshot = await handle.stat(options)
          state.observedStatBytes = Number(snapshot.size)
          if (state.growth) {
            const growth = state.growth
            state.growth = ''
            await fs.appendFile(path, growth)
          }
          return snapshot
        },
        createReadStream: (options: Parameters<FileHandle['createReadStream']>[0]) => {
          state.streams += 1
          const stream = handle.createReadStream(options)
          if (state.readError) {
            queueMicrotask(() => stream.destroy(new Error('Injected read failure')))
            return stream
          }
          stream.on('data', (chunk: Buffer | string) => {
            const size = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk)
            state.bytesRead += size
            state.peakChunkBytes = Math.max(state.peakChunkBytes, size)
          })
          return stream
        },
        close: async () => {
          state.closes += 1
          await handle.close()
        }
      }
    }
  }
})

import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readClaudeProviderHistory } from './claude-structured-history-window'
import { pinClaudeTranscript } from './claude-transcript-branch-proof'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'

const LEGACY_LIMIT = 16 * 1024 * 1024
const SOURCE = `${[
  {
    type: 'user',
    uuid: 'anchor',
    parentUuid: null,
    sessionId: 'provider',
    message: { role: 'user', content: 'before' }
  },
  {
    type: 'user',
    uuid: 'latest',
    parentUuid: 'anchor',
    sessionId: 'provider',
    message: { role: 'user', content: 'after' }
  },
  { type: 'last-prompt', sessionId: 'provider', leafUuid: 'latest' }
]
  .map((row) => JSON.stringify(row))
  .join('\n')}\n`
let directory = ''

const read = async (previousLeafUuid: string | null = 'anchor') =>
  readClaudeProviderHistory(await pinClaudeTranscript(state.path), {
    providerSessionId: 'provider',
    previousLeafUuid,
    sessionId: 'orca',
    turnInFlight: false
  })

/** Filler rows, so the padding a size test needs is still valid JSONL. */
function padTo(bytes: number): string {
  const filler = `${JSON.stringify({ type: 'comment', note: 'x'.repeat(4096) })}\n`
  const rows = Math.ceil((bytes - Buffer.byteLength(SOURCE)) / Buffer.byteLength(filler))
  return filler.repeat(Math.max(rows, 0)) + SOURCE
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-history-source-budget-'))
  Object.assign(state, {
    path: join(directory, 'session.jsonl'),
    growth: '',
    readError: false,
    bytesRead: 0,
    peakChunkBytes: 0,
    streams: 0,
    opens: 0,
    closes: 0,
    observedStatBytes: 0
  })
  await writeFile(state.path, SOURCE)
})

afterEach(async (context) => {
  try {
    const output = process.env.ORCA_HISTORY_BUDGET_PROOF_OUTPUT
    if (output) {
      await appendFile(
        output,
        `${JSON.stringify({
          test: context.task.name,
          bytesRead: state.bytesRead,
          peakChunkBytes: state.peakChunkBytes,
          observedStatBytes: state.observedStatBytes,
          streams: state.streams,
          opens: state.opens,
          closes: state.closes
        })}\n`
      )
    }
    expect(state.closes).toBe(state.opens)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('Claude provider history source budget', () => {
  it('reads a stable history without changing prompt evidence', async () => {
    const result = await read()
    expect(result.boundaryConsistent).toBe(true)
    expect(result.items.map((item) => item.providerItemId)).toEqual(['latest'])
  })

  it('streams one pass for the window and the recorded history together', async () => {
    const result = await read()
    expect(result.recorded?.itemIds.size).toBe(2)
    // The proof, the window and the id lookup all come from the same bytes, read once.
    expect(state.opens).toBe(1)
    expect(state.streams).toBe(1)
    expect(state.bytesRead).toBe(Buffer.byteLength(SOURCE))
  })

  it('resolves a source past the legacy whole-file limit instead of refusing it', async () => {
    // The old bounded read returned an inconsistent boundary here, which is the
    // one answer reconciliation can never act on.
    await writeFile(state.path, padTo(LEGACY_LIMIT + 1))
    expect(state.observedStatBytes).toBe(0)

    const result = await read()

    expect(result.boundaryConsistent).toBe(true)
    expect(result.items.map((item) => item.providerItemId)).toEqual(['latest'])
    expect(state.bytesRead).toBeGreaterThan(LEGACY_LIMIT)
  })

  it('keeps resident bytes bounded by the chunk size, not the file size', async () => {
    await writeFile(state.path, padTo(LEGACY_LIMIT + 1))
    expect((await read()).boundaryConsistent).toBe(true)
    // A whole-file read would show one chunk the size of the transcript.
    expect(state.peakChunkBytes).toBeLessThan(1024 * 1024)
  })

  it('refuses a single record too large to frame', async () => {
    // Per-record, not per-file: the framer buffers one line, so an unbounded
    // record is the only remaining way for the source to become resident.
    const huge = `${JSON.stringify({ type: 'comment', note: 'x'.repeat(LEGACY_LIMIT) })}\n`
    await writeFile(state.path, huge + SOURCE)
    expect((await read()).boundaryConsistent).toBe(false)
  })

  it('never reads what was appended after the pin, even to finish a torn tail', async () => {
    const grown = `${JSON.stringify({
      type: 'user',
      uuid: 'grown',
      parentUuid: 'latest',
      sessionId: 'provider',
      message: { role: 'user', content: 'appended' }
    })}\n`
    const torn = Math.floor(grown.length / 2)
    await writeFile(state.path, SOURCE + grown.slice(0, torn))
    const pinned = await pinClaudeTranscript(state.path)
    // A child started after the pin may be the writer, so its bytes are no evidence.
    await appendFile(state.path, grown.slice(torn))

    const result = await readClaudeProviderHistory(pinned, {
      providerSessionId: 'provider',
      previousLeafUuid: 'anchor',
      sessionId: 'orca',
      turnInFlight: false
    })

    expect(result.boundaryConsistent).toBe(false)
    // The torn line may be the record, so the file does not prove its absence.
    const grownKey = agentJournalItemKey({
      provider: 'claude',
      sessionId: 'provider',
      uuid: 'grown'
    })
    expect(result.recorded?.provesAbsenceOf(grownKey)).toBe(false)
    expect(state.streams).toBe(1)
    expect(state.bytesRead).toBe(pinned.size)
  })

  it('preserves the inconsistent result on a read error', async () => {
    state.readError = true
    expect((await read()).boundaryConsistent).toBe(false)
  })

  it('still reads the recorded history, once, without an anchor', async () => {
    const result = await read(null)
    expect(result.boundaryConsistent).toBe(false)
    expect(result.recorded?.itemIds.size).toBe(2)
    expect(state.streams).toBe(1)
  })
})
