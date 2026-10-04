import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_ATTACHMENT_PART_FILE,
  AgentSessionAttachmentStore
} from './agent-session-attachment-store'
import { sweepAgentSessionAttachments } from './agent-session-attachment-sweep'

const HOUR = 60 * 60 * 1000
const NOW = Date.now()

let root: string
let store: AgentSessionAttachmentStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-attachment-sweep-'))
  store = new AgentSessionAttachmentStore(join(root, 'agent-session-attachments'))
})

afterEach(async () => {
  store.clearInFlightForTests()
  await rm(root, { recursive: true, force: true })
})

/** A stored upload (or a bare part file) last touched `ageMs` ago. */
async function seedUpload(
  sessionId: string,
  uploadId: string,
  ageMs: number,
  file: string = 'shot.png'
): Promise<string> {
  const uploadDir = join(store.sessionDirectory(sessionId), uploadId)
  await mkdir(uploadDir, { recursive: true })
  await writeFile(join(uploadDir, file), 'bytes')
  const at = new Date(NOW - ageMs)
  await utimes(uploadDir, at, at)
  return join(uploadDir, file)
}

async function remaining(sessionId: string): Promise<string[]> {
  return readdir(store.sessionDirectory(sessionId)).catch(() => [])
}

describe('sweepAgentSessionAttachments', () => {
  it('removes a part file nobody finished after an hour, and keeps a fresh one', async () => {
    await seedUpload('session-1', 'stale', HOUR + 1, AGENT_SESSION_ATTACHMENT_PART_FILE)
    await seedUpload('session-1', 'fresh', HOUR - 1000, AGENT_SESSION_ATTACHMENT_PART_FILE)
    await sweepAgentSessionAttachments(
      store,
      { recordedSessionIds: () => ['session-1'], journalMentions: () => true },
      NOW
    )
    expect(await remaining('session-1')).toEqual(['fresh'])
  })

  it('removes the uploads of a chat that never came to exist, after a day', async () => {
    await seedUpload('ghost', 'old', 24 * HOUR + 1)
    await seedUpload('ghost', 'new', HOUR)
    await sweepAgentSessionAttachments(
      store,
      { recordedSessionIds: () => [], journalMentions: () => null },
      NOW
    )
    expect(await remaining('ghost')).toEqual(['new'])
  })

  it('judges nothing abandoned while the record list is incomplete', async () => {
    await seedUpload('ghost', 'old', 24 * HOUR + 1)
    await sweepAgentSessionAttachments(
      store,
      { recordedSessionIds: () => null, journalMentions: () => null },
      NOW
    )
    expect(await remaining('ghost')).toEqual(['old'])
  })

  it("removes a recorded chat's upload its journal never mentions, and keeps a sent one", async () => {
    const sent = await seedUpload('session-1', 'sent', 48 * HOUR)
    await seedUpload('session-1', 'unsent', 48 * HOUR)
    const journalMentions = vi.fn(
      (_sessionId: string, needle: string) => needle === JSON.stringify(sent).slice(1, -1)
    )
    await sweepAgentSessionAttachments(
      store,
      { recordedSessionIds: () => ['session-1'], journalMentions },
      NOW
    )
    expect(await remaining('session-1')).toEqual(['sent'])
    expect(journalMentions).toHaveBeenCalledWith('session-1', expect.any(String))
  })

  it('keeps a recorded chat upload while its journal holds no rows yet', async () => {
    await seedUpload('session-1', 'unknown', 48 * HOUR)
    await sweepAgentSessionAttachments(
      store,
      { recordedSessionIds: () => ['session-1'], journalMentions: () => null },
      NOW
    )
    expect(await remaining('session-1')).toEqual(['unknown'])
  })

  it('does not rescan a file already proven sent', async () => {
    await seedUpload('session-1', 'sent', 48 * HOUR)
    const journalMentions = vi.fn(() => true)
    const known = new Set<string>()
    const facts = { recordedSessionIds: () => ['session-1'], journalMentions }
    await sweepAgentSessionAttachments(store, facts, NOW, known)
    await sweepAgentSessionAttachments(store, facts, NOW, known)
    expect(journalMentions).toHaveBeenCalledTimes(1)
  })

  it('leaves an upload in flight alone however old its directory is', async () => {
    const { uploadId } = await store.startUpload({
      callerKey: 'client-a',
      sessionId: 'ghost',
      name: 'a.txt',
      byteLength: 1
    })
    const at = new Date(NOW - 48 * HOUR)
    await utimes(join(store.sessionDirectory('ghost'), uploadId), at, at)
    await sweepAgentSessionAttachments(
      store,
      { recordedSessionIds: () => [], journalMentions: () => null },
      NOW
    )
    expect(await remaining('ghost')).toEqual([uploadId])
  })

  it('reads no facts when nothing is stored', async () => {
    const recordedSessionIds = vi.fn(() => [])
    await sweepAgentSessionAttachments(
      store,
      { recordedSessionIds, journalMentions: () => null },
      NOW
    )
    expect(recordedSessionIds).not.toHaveBeenCalled()
  })
})
