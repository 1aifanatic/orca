// When a stored attachment may go, re-derived from what the host already holds.
//
// - A part file nobody is writing (the uploader crashed or vanished) goes after an hour.
// - A chat the host has no record of never came to exist: its uploads go after a day.
// - A recorded chat's upload that its journal never mentions after a day was never sent (the chip
//   was removed, the draft abandoned): it goes too. A chat with no journal rows yet is no evidence.
// - Everything a chat's journal mentions lives as long as that chat. The host never deletes a chat
//   today, so that is as long as its transcript.

import { readdir, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { journalPathSegment } from '../agent-session-journal/journal-paths'
import {
  AGENT_SESSION_ATTACHMENT_PART_FILE,
  removeQuietly,
  type AgentSessionAttachmentStore
} from './agent-session-attachment-store'

export const ABANDONED_PART_MAX_AGE_MS = 60 * 60 * 1000
export const UNSENT_ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000

export type AgentSessionAttachmentSweepFacts = {
  /** Every chat this host holds a record for; null while that list is incomplete (records still
   *  owed their import), when no upload can be judged abandoned. */
  recordedSessionIds: () => Iterable<string> | null
  /** Whether the chat's journal mentions `needle`; null when the journal holds no rows yet. */
  journalMentions: (sessionId: string, needle: string) => boolean | null
}

export type AgentSessionAttachmentSweepResult = { removed: string[] }

export async function sweepAgentSessionAttachments(
  store: AgentSessionAttachmentStore,
  facts: AgentSessionAttachmentSweepFacts,
  now = Date.now(),
  /** Verdicts already proven this process: a sent file stays sent, so it is not rescanned. */
  knownReferenced = new Set<string>()
): Promise<AgentSessionAttachmentSweepResult> {
  const removed: string[] = []
  const sessionSegments = await listDirectories(store.rootDir)
  if (sessionSegments.length === 0) {
    return { removed }
  }
  const recorded = facts.recordedSessionIds()
  const sessionIdBySegment = new Map<string, string>()
  for (const sessionId of recorded ?? []) {
    sessionIdBySegment.set(journalPathSegment(sessionId), sessionId)
  }
  for (const sessionSegment of sessionSegments) {
    const sessionDir = join(store.rootDir, sessionSegment)
    const sessionId = sessionIdBySegment.get(sessionSegment) ?? null
    const recordsComplete = recorded !== null
    for (const uploadId of await listDirectories(sessionDir)) {
      if (store.isUploadInFlight(uploadId)) {
        continue
      }
      const uploadDir = join(sessionDir, uploadId)
      const verdict = await uploadVerdict(uploadDir, {
        sessionId,
        recordsComplete,
        facts,
        now,
        knownReferenced
      })
      if (verdict === 'remove') {
        await removeQuietly(uploadDir)
        removed.push(uploadDir)
      }
      // Each scan can read a long journal; let other work run between uploads.
      await new Promise((resolve) => setImmediate(resolve))
    }
    // Non-recursive, so an upload that starts in this chat meanwhile keeps its directory.
    await rmdir(sessionDir).catch(() => {})
  }
  return { removed }
}

async function uploadVerdict(
  uploadDir: string,
  context: {
    sessionId: string | null
    recordsComplete: boolean
    facts: AgentSessionAttachmentSweepFacts
    now: number
    knownReferenced: Set<string>
  }
): Promise<'keep' | 'remove'> {
  const { sessionId, recordsComplete, facts, now, knownReferenced } = context
  const entries = await listEntries(uploadDir)
  const stored = entries.filter((entry) => entry !== AGENT_SESSION_ATTACHMENT_PART_FILE)
  const ageMs = now - (await modifiedAt(uploadDir))
  if (stored.length === 0) {
    return ageMs > ABANDONED_PART_MAX_AGE_MS ? 'remove' : 'keep'
  }
  if (ageMs <= UNSENT_ATTACHMENT_MAX_AGE_MS) {
    return 'keep'
  }
  if (sessionId === null) {
    return recordsComplete ? 'remove' : 'keep'
  }
  const path = join(uploadDir, stored[0])
  if (knownReferenced.has(path)) {
    return 'keep'
  }
  // Journal rows are JSON, so the path appears there escaped.
  const mentioned = facts.journalMentions(sessionId, JSON.stringify(path).slice(1, -1))
  if (mentioned === true) {
    knownReferenced.add(path)
  }
  return mentioned === false ? 'remove' : 'keep'
}

async function listEntries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

async function modifiedAt(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export type AgentSessionAttachmentSweeper = { stop: () => void }

/**
 * Sweeps shortly after the host comes up and then periodically. Best effort: a failed sweep is
 * logged and the next one tries again; nothing waits on it.
 */
export function startAgentSessionAttachmentSweeps(
  store: AgentSessionAttachmentStore,
  facts: AgentSessionAttachmentSweepFacts,
  options: {
    initialDelayMs: number
    intervalMs: number
    onError: (error: unknown) => void
  }
): AgentSessionAttachmentSweeper {
  const knownReferenced = new Set<string>()
  let running = false
  let stopped = false
  const run = (): void => {
    if (running || stopped) {
      return
    }
    running = true
    void sweepAgentSessionAttachments(store, facts, Date.now(), knownReferenced)
      .catch(options.onError)
      .finally(() => {
        running = false
      })
  }
  const initial = setTimeout(run, options.initialDelayMs)
  const interval = setInterval(run, options.intervalMs)
  initial.unref?.()
  interval.unref?.()
  return {
    stop: () => {
      stopped = true
      clearTimeout(initial)
      clearInterval(interval)
    }
  }
}
