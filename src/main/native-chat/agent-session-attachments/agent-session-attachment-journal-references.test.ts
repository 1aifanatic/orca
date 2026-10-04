import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { createAgentSessionAttachmentJournalMentions } from './agent-session-attachment-journal-references'

// A Windows path is the case that matters: JSON escapes its separators, so a raw-path search misses.
const storedPath = 'C:\\Users\\me\\AppData\\Orca\\agent-session-attachments\\abc\\u1\\shot.png'
const needle = JSON.stringify(storedPath).slice(1, -1)

let stateDirectory: string

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-attachment-journal-'))
})

afterEach(async () => {
  closeTestJournalHostDatabase(stateDirectory)
  await rm(stateDirectory, { recursive: true, force: true })
})

function insertRow(sessionId: string, seq: number, row: unknown): void {
  openTestJournalHostDatabase(stateDirectory)
    .db.prepare(
      'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
    )
    .run(sessionId, 'epoch-1', seq, 1, JSON.stringify(row))
}

describe('createAgentSessionAttachmentJournalMentions', () => {
  it('finds a sent image by its path in the chat journal', () => {
    insertRow('session-1', 1, {
      kind: 'item',
      body: { kind: 'message', blocks: [{ type: 'image-ref', path: storedPath }] }
    })
    const mentions = createAgentSessionAttachmentJournalMentions(
      () => openTestJournalHostDatabase(stateDirectory).db
    )
    expect(mentions('session-1', needle)).toBe(true)
    expect(mentions('session-1', JSON.stringify('/other.png').slice(1, -1))).toBe(false)
  })

  it('finds a file referenced in message text', () => {
    insertRow('session-1', 1, {
      body: { kind: 'message', blocks: [{ type: 'text', text: `look at @${storedPath} please` }] }
    })
    const mentions = createAgentSessionAttachmentJournalMentions(
      () => openTestJournalHostDatabase(stateDirectory).db
    )
    expect(mentions('session-1', needle)).toBe(true)
  })

  it("does not count another chat's journal", () => {
    insertRow('session-2', 1, { blocks: [{ type: 'image-ref', path: storedPath }] })
    insertRow('session-1', 1, { blocks: [{ type: 'text', text: 'hello' }] })
    const mentions = createAgentSessionAttachmentJournalMentions(
      () => openTestJournalHostDatabase(stateDirectory).db
    )
    expect(mentions('session-1', needle)).toBe(false)
  })

  it('counts a host-held queued draft', () => {
    insertRow('session-1', 1, { blocks: [{ type: 'text', text: 'hello' }] })
    openTestJournalHostDatabase(stateDirectory)
      .db.prepare(
        `INSERT INTO queued_messages
           (session_id, message_id, position, body_json, fingerprint, created_at, host_instance, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'session-1',
        'queued-1',
        0,
        JSON.stringify({ blocks: [{ type: 'image-ref', path: storedPath }] }),
        'fp',
        1,
        'host-1',
        'queued'
      )
    const mentions = createAgentSessionAttachmentJournalMentions(
      () => openTestJournalHostDatabase(stateDirectory).db
    )
    expect(mentions('session-1', needle)).toBe(true)
  })

  it('says nothing about a chat whose journal holds no rows', () => {
    const mentions = createAgentSessionAttachmentJournalMentions(
      () => openTestJournalHostDatabase(stateDirectory).db
    )
    expect(mentions('session-1', needle)).toBeNull()
  })
})
