import type { FileHandle } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

type ReaderState = {
  path: string
  opens: number
  closes: number
  handles: FileHandle[]
  bytesRead: number
  statError: boolean
  readError: boolean
  afterOpen: (() => Promise<void>) | null
}

const state = vi.hoisted((): ReaderState => ({
  path: '',
  opens: 0,
  closes: 0,
  handles: [],
  bytesRead: 0,
  statError: false,
  readError: false,
  afterOpen: null
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
      state.opens++
      state.handles.push(handle)
      return {
        stat: async (options?: Parameters<FileHandle['stat']>[0]) => {
          if (state.statError) {
            throw new Error('Injected stat failure')
          }
          const snapshot = await handle.stat(options)
          const afterOpen = state.afterOpen
          state.afterOpen = null
          await afterOpen?.()
          return snapshot
        },
        createReadStream: (options: Parameters<FileHandle['createReadStream']>[0]) => {
          const stream = handle.createReadStream(options)
          stream.once('end', () => {
            state.bytesRead += stream.bytesRead
          })
          if (state.readError) {
            queueMicrotask(() => stream.destroy(new Error('Injected read failure')))
          }
          return stream
        },
        close: async () => {
          await handle.close()
          state.closes++
        }
      }
    }
  }
})

import { appendFile, mkdtemp, rename, rm, truncate, unlink, writeFile } from 'node:fs/promises'
import {
  ClaudeTranscriptPreviousCursorMissingError,
  ClaudeTranscriptTailIncompleteError,
  createClaudeBranchAncestryPass,
  pinClaudeTranscript,
  readPinnedClaudeTranscript,
  type ClaudeTranscriptSnapshot
} from './claude-transcript-branch-proof'

const row = (uuid: string, parentUuid: string | null, extra = {}) =>
  `${JSON.stringify({ type: 'user', uuid, parentUuid, sessionId: 'provider', ...extra })}\n`
const marker = (leafUuid: string, sessionId = 'provider') =>
  `${JSON.stringify({ type: 'last-prompt', leafUuid, sessionId })}\n`
/** Carries no uuid, so it can be neither a tip nor a marker. */
const SUMMARY = `${JSON.stringify({ type: 'summary', summary: 'title' })}\n`
const ROOT = row('root', null)
const CHILD = row('child', 'root')
const SOURCE = ROOT + marker('root')
let directory = ''

async function readLines(snapshot: ClaudeTranscriptSnapshot): Promise<string[]> {
  const lines: string[] = []
  await readPinnedClaudeTranscript(snapshot, Infinity, (line) => lines.push(line))
  return lines
}

/** The proof over `contents` as a shared line pass feeds it; `firstSeen` is what the pass reports. */
function prove(contents: string, anchorUuid = 'root') {
  const pass = createClaudeBranchAncestryPass({
    providerSessionId: 'provider',
    previousLeafUuid: anchorUuid,
    ancestryAnchorUuid: anchorUuid
  })
  const firstSeen: string[] = []
  const lines = contents.split('\n')
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue
    }
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      pass.reject(index < lines.length - 1)
      continue
    }
    const uuid = pass.add(record, index)
    if (uuid) {
      firstSeen.push(uuid)
    }
  }
  return { finish: () => pass.finish(), firstSeen }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-branch-streaming-'))
  Object.assign(state, {
    path: join(directory, 'transcript.jsonl'),
    opens: 0,
    closes: 0,
    handles: [],
    bytesRead: 0,
    statError: false,
    readError: false,
    afterOpen: null
  })
  await writeFile(state.path, SOURCE)
})

afterEach(async () => {
  try {
    expect(state.closes).toBe(state.opens)
    for (const handle of state.handles) {
      // Another test can reuse a closed descriptor number in this process.
      expect(handle.fd).toBe(-1)
      await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('decodes UTF-8 across chunks and frames lines beyond large message bodies', async () => {
  const prefix = JSON.stringify({ type: 'comment', content: '' }).indexOf('"content":"') + 11
  const comment = `${JSON.stringify({ type: 'comment', content: `${'x'.repeat(65535 - prefix)}🙂é漢字` })}\n`
  const contents =
    comment +
    row('root', null, { message: 'x'.repeat(2 * 1024 * 1024) }) +
    CHILD +
    marker('child').trimEnd()
  await writeFile(state.path, contents)

  expect(await readLines(await pinClaudeTranscript(state.path))).toEqual(contents.split('\n'))
  expect(prove(contents).finish()).toEqual({
    proof: { leafUuid: 'child', relation: 'descendant' },
    chain: ['child']
  })
})

it('reads only the pinned bytes while the same file grows', async () => {
  const snapshot = await pinClaudeTranscript(state.path)
  await appendFile(state.path, CHILD + marker('child'))
  state.afterOpen = () => appendFile(state.path, ' '.repeat(1024 * 1024))

  expect((await readLines(snapshot)).join('\n')).toBe(SOURCE)
  expect(state.bytesRead).toBe(Buffer.byteLength(SOURCE))
  expect(state.opens).toBe(1)
})

it.each([
  [
    'replaced',
    async () => {
      await rename(state.path, `${state.path}.original`)
      await writeFile(state.path, ROOT + CHILD + marker('child'))
    }
  ],
  ['truncated', () => truncate(state.path, 0)]
] as const)('refuses a file %s after the pin', async (_name, change) => {
  const snapshot = await pinClaudeTranscript(state.path)
  await change()
  await expect(readLines(snapshot)).rejects.toThrow('replaced or truncated')
})

it('refuses a file truncated while it is read', async () => {
  const snapshot = await pinClaudeTranscript(state.path)
  state.afterOpen = () => truncate(state.path, 3)
  await expect(readLines(snapshot)).rejects.toThrow('truncated while it was read')
})

it('refuses a file unlinked after the pin', async () => {
  const snapshot = await pinClaudeTranscript(state.path)
  await unlink(state.path)
  await expect(readLines(snapshot)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['stat', 'read'] as const)('awaits closure after a %s failure', async (failure) => {
  const snapshot = await pinClaudeTranscript(state.path)
  state.statError = failure === 'stat'
  state.readError = failure === 'read'
  await expect(readLines(snapshot)).rejects.toThrow(`Injected ${failure} failure`)
})

it('opens no stream for an empty pin', async () => {
  await writeFile(state.path, '')
  expect(await readLines(await pinClaudeTranscript(state.path))).toEqual([])
  expect(state.bytesRead).toBe(0)
})

it.each([
  ['malformed middle', `{"broken":\n${SOURCE}`, false],
  ['unterminated malformed tail', `${SOURCE}{"broken":`, true],
  ['terminated malformed tail', `${SOURCE}{"broken":\n`, false]
] as const)('preserves error classification for %s', (_name, contents, incomplete) => {
  let error: unknown = null
  try {
    prove(contents).finish()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
  expect(error instanceof ClaudeTranscriptTailIncompleteError).toBe(incomplete)
})

it('reports each uuid once, at its first line', () => {
  const { finish, firstSeen } = prove(ROOT + CHILD + CHILD + marker('child'))
  expect(finish().chain).toEqual(['child'])
  expect(firstSeen).toEqual(['root', 'child'])
})

it.each(['', SUMMARY])('keeps a missing tip fatal', (contents) => {
  expect(prove(contents).finish).toThrow('missing last-prompt marker')
})

it('preserves the typed missing-cursor error for existing root reproof', () => {
  expect(prove(SOURCE, 'absent').finish).toThrow(ClaudeTranscriptPreviousCursorMissingError)
})

it.each([
  ['conflict', ROOT + row('root', 'foreign') + marker('root'), 'root', 'conflicting ancestry'],
  ['wrong session', ROOT + marker('root', 'foreign'), 'root', 'invalid last-prompt'],
  ['append order', CHILD + ROOT, 'root', 'parent row follows'],
  ['missing ancestor', CHILD, 'child', 'missing ancestor']
] as const)('fails the proof on %s', (_name, contents, anchor, message) => {
  expect(prove(contents, anchor).finish).toThrow(message)
})
