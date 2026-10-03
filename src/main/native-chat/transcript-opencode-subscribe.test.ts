import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import {
  readOpenCodeTranscriptPage,
  readOpenCodeTranscriptSignal
} from './transcript-opencode-sqlite-query'
import { subscribeOpenCodeNativeChatTranscript } from './transcript-opencode-subscribe'

const fixtures: { db: Database.Database; root: string; stop: () => void }[] = []
afterEach(() => {
  for (const { db, root, stop } of fixtures.splice(0)) {
    stop()
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
  vi.useRealTimers()
})

function watchFixture(version: 'v1' | 'v2', hiddenFirst = false) {
  vi.useFakeTimers()
  const root = mkdtempSync(join(tmpdir(), 'orca-opencode-watch-'))
  const path = join(root, 'opencode.db')
  const db = new Database(path)
  db.exec(
    version === 'v1'
      ? `
    CREATE TABLE session (id TEXT PRIMARY KEY);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_updated INTEGER);
    INSERT INTO session VALUES ('session');
  `
      : `
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT, time_created INTEGER, time_updated INTEGER);
    INSERT INTO session_v2 VALUES ('session');
  `
  )
  const insert = (index: number, text = `message ${index}`) => {
    if (version === 'v1') {
      db.prepare('INSERT INTO message VALUES (?, ?, ?, 1, 1)').run(
        String(index),
        'session',
        '{"role":"user"}'
      )
      db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, 1)').run(
        String(index),
        String(index),
        'session',
        JSON.stringify({ type: 'text', text })
      )
    } else {
      db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, 1, 1)').run(
        String(index),
        'session',
        'user',
        index,
        JSON.stringify({ text })
      )
    }
  }
  const update = (index: number, text: string, time = 2) => {
    db.prepare(
      version === 'v1'
        ? 'UPDATE part SET data = ?, time_updated = ? WHERE message_id = ?'
        : 'UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?'
    ).run(JSON.stringify(version === 'v1' ? { type: 'text', text } : { text }), time, String(index))
  }
  const remove = (index: number) => {
    if (version === 'v1') {
      db.prepare('DELETE FROM part WHERE message_id = ?').run(String(index))
      db.prepare('DELETE FROM message WHERE id = ?').run(String(index))
    } else {
      db.prepare('DELETE FROM session_message WHERE id = ?').run(String(index))
    }
  }
  for (let index = 1; index <= 300; index++) {
    insert(index, hiddenFirst && index === 1 ? '' : undefined)
  }
  let displayed: NativeChatMessage[] = []
  const onReplace = vi.fn((messages: NativeChatMessage[]) => {
    displayed = messages
  })
  const readPage = vi.fn(async (args: Parameters<typeof readOpenCodeTranscriptPage>[0]) =>
    readOpenCodeTranscriptPage(args)
  )
  const subscription = subscribeOpenCodeNativeChatTranscript(
    {
      agent: 'opencode',
      sessionId: 'session',
      initialLimit: 300,
      resolvePollIntervalMs: 5,
      onInitialSnapshot: (messages) => {
        displayed = messages
      },
      onAppend: (messages) => {
        displayed.push(...messages)
      },
      onReplace
    },
    undefined,
    {
      resolveDbPath: async () => path,
      readSignal: async (dbPath, sessionId) => readOpenCodeTranscriptSignal(dbPath, sessionId),
      readPage
    }
  )
  fixtures.push({ db, root, stop: subscription.unsubscribe })
  return { db, insert, update, remove, displayed: () => displayed, onReplace, readPage }
}

describe.each(['v1', 'v2'] as const)('OpenCode %s watch reconciliation', (version) => {
  it('replaces an edit older than the newest 100 displayed messages', async () => {
    const f = watchFixture(version)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.displayed()).toHaveLength(300)
    f.update(1, 'edited oldest')
    await vi.advanceTimersByTimeAsync(10)
    expect(f.displayed()[0]?.blocks).toEqual([{ type: 'text', text: 'edited oldest' }])
    expect(f.onReplace).toHaveBeenCalledOnce()
  })

  it('includes an older row that becomes renderable after the emitted frontier', async () => {
    const f = watchFixture(version, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.displayed()).toHaveLength(299)
    f.update(1, 'newly renderable')
    await vi.advanceTimersByTimeAsync(10)
    expect(f.displayed()[0]?.blocks).toEqual([{ type: 'text', text: 'newly renderable' }])
    expect(f.displayed()).toHaveLength(300)
  })

  it.each([1, 300])('removes a deleted row at %s from the displayed window', async (index) => {
    const f = watchFixture(version)
    await vi.advanceTimersByTimeAsync(0)
    f.remove(index)
    await vi.advanceTimersByTimeAsync(10)
    expect(f.displayed()).toHaveLength(299)
    expect(
      f
        .displayed()
        .some((message) => message.id === (version === 'v1' ? String(index) : `opencode:${index}`))
    ).toBe(false)
    expect(f.onReplace).toHaveBeenCalledOnce()
  })

  it('replaces an empty session and permits a reused provider cursor to append', async () => {
    const f = watchFixture(version)
    await vi.advanceTimersByTimeAsync(0)
    for (let index = 1; index <= 300; index++) {
      f.remove(index)
    }
    await vi.advanceTimersByTimeAsync(10)
    expect(f.displayed()).toEqual([])
    f.insert(1, 'after revert')
    await vi.advanceTimersByTimeAsync(10)
    expect(f.displayed().map((message) => message.blocks)).toEqual([
      [{ type: 'text', text: 'after revert' }]
    ])
  })

  it('removes a row whose last renderable content is removed', async () => {
    const f = watchFixture(version)
    await vi.advanceTimersByTimeAsync(0)
    f.update(1, '')
    await vi.advanceTimersByTimeAsync(10)
    expect(f.displayed()).toHaveLength(299)
    expect(f.displayed()[0]?.blocks).toEqual([{ type: 'text', text: 'message 2' }])
  })

  it('continues checking previously appended history and bounds every read', async () => {
    const f = watchFixture(version)
    await vi.advanceTimersByTimeAsync(0)
    for (let index = 301; index <= 450; index++) {
      f.insert(index)
    }
    await vi.advanceTimersByTimeAsync(10)
    f.update(1, 'edited after append')
    await vi.advanceTimersByTimeAsync(10)
    expect(f.displayed()[0]?.blocks).toEqual([{ type: 'text', text: 'edited after append' }])
    expect(f.readPage.mock.calls.every(([args]) => args.limit <= 2400)).toBe(true)
    const reads = f.readPage.mock.calls.length
    await vi.advanceTimersByTimeAsync(20)
    expect(f.readPage).toHaveBeenCalledTimes(reads)
  })

  it('holds the frontier and retries when a burst cannot bridge within the read cap', async () => {
    const f = watchFixture(version)
    await vi.advanceTimersByTimeAsync(0)
    for (let index = 301; index <= 2800; index++) {
      f.insert(index)
    }
    await vi.advanceTimersByTimeAsync(10)
    expect(f.displayed()).toHaveLength(300)
    expect(f.onReplace).not.toHaveBeenCalled()
    const reads = f.readPage.mock.calls.length
    await vi.advanceTimersByTimeAsync(10)
    expect(f.readPage.mock.calls.length).toBeGreaterThan(reads)
    expect(f.readPage.mock.calls.every(([args]) => args.limit <= 2400)).toBe(true)
    for (let index = 301; index <= 2800; index++) {
      f.remove(index)
    }
    f.insert(301, 'after discarded burst')
    await vi.advanceTimersByTimeAsync(10)
    expect(f.displayed()).toHaveLength(301)
    expect(f.displayed().at(-1)?.blocks).toEqual([{ type: 'text', text: 'after discarded burst' }])
  })
})
