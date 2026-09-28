// Write-ahead persistence for the mutations that owe the composer text back:
// a Stop or /clear that withdraws queued drafts, and an Edit that deletes one to
// reclaim its body. The operation identity is persisted BEFORE the RPC — the
// order the send journal already establishes — so the restore settles exactly
// once however many times the answer is asked for. Across a relaunch only an
// Edit is finished; a Stop or /clear handle is released, never reissued (see
// takeRelaunchQueuedRestoreOperations). Every entry also dies on its own once
// the host's replay window has passed.

import AsyncStorage from '@react-native-async-storage/async-storage'
import { z } from 'zod'
import { persistMirrored } from '../storage/mirrored-storage-keys'
import {
  AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS,
  parseAgentSessionOperationTimestamp
} from '../../../src/shared/agent-session-host-authority'
import { structuredAgentSessionDomainFingerprint } from '../../../src/shared/structured-agent-session-mutation'

const STORAGE_KEY = 'orca:mobileStructuredQueuedRestore:v1'
/** Restoration obligations are rare and short-lived; a runaway caller is a bug. */
const MAX_ENTRIES = 64

const RestoreEntrySchema = z.discriminatedUnion('method', [
  z
    .object({
      method: z.literal('agentSession.cancel'),
      entryKey: z.string().regex(/^[0-9a-f]{64}$/),
      sessionId: z.string().min(1).max(512),
      sessionKey: z.string().min(1).max(512),
      /** Composer scope the withdrawn text goes back to. */
      draftKey: z.string().min(1).max(512),
      operationId: z.string().max(128),
      fields: z.object({ turnId: z.string().min(1).max(512) }).strict()
    })
    .strict(),
  z
    .object({
      method: z.literal('agentSession.queuedMessageDelete'),
      entryKey: z.string().regex(/^[0-9a-f]{64}$/),
      sessionId: z.string().min(1).max(512),
      sessionKey: z.string().min(1).max(512),
      draftKey: z.string().min(1).max(512),
      operationId: z.string().max(128),
      fields: z.object({ messageId: z.string().min(1).max(512) }).strict()
    })
    .strict(),
  z
    .object({
      method: z.literal('agentSession.conversationCommand'),
      entryKey: z.string().regex(/^[0-9a-f]{64}$/),
      sessionId: z.string().min(1).max(512),
      sessionKey: z.string().min(1).max(512),
      draftKey: z.string().min(1).max(512),
      operationId: z.string().max(128),
      fields: z.object({ command: z.literal('clear') }).strict()
    })
    .strict()
])

const RestoreJournalSchema = z
  .object({ v: z.literal(1), entries: z.array(RestoreEntrySchema).max(MAX_ENTRIES) })
  .strict()

export type QueuedRestoreEntry = z.infer<typeof RestoreEntrySchema>

const mutations: { tail: Promise<void> } = { tail: Promise.resolve() }

function serialize<T>(action: () => Promise<T>): Promise<T> {
  const operation = mutations.tail.then(action, action)
  mutations.tail = operation.then(
    () => undefined,
    () => undefined
  )
  return operation
}

export function queuedRestoreEntryKey(input: {
  sessionKey: string
  method: QueuedRestoreEntry['method']
  fields: Record<string, unknown>
}): string {
  return structuredAgentSessionDomainFingerprint({
    domain: 'mobile.agentSession.queuedRestore',
    sessionId: input.sessionKey,
    fields: { method: input.method, fields: input.fields }
  })
}

function entryIsLive(entry: QueuedRestoreEntry, now: number): boolean {
  const timestamp = parseAgentSessionOperationTimestamp(entry.operationId)
  return timestamp !== null && now - timestamp <= AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS
}

async function readEntries(now: number): Promise<QueuedRestoreEntry[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY)
  if (raw === null) {
    return []
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  const parsed = RestoreJournalSchema.safeParse(value)
  // A journal this build cannot read must not block a Stop or an Edit — the
  // replay handles it held are gone either way; start over.
  if (!parsed.success) {
    return []
  }
  return parsed.data.entries.filter((entry) => entryIsLive(entry, now))
}

async function writeEntries(entries: readonly QueuedRestoreEntry[]): Promise<void> {
  // Mirrored and page-allowlisted like the send journal: inside the page an
  // unlisted key reads back empty, so the settle would find no entry and drop the text.
  await persistMirrored(
    STORAGE_KEY,
    entries.length === 0 ? null : JSON.stringify({ v: 1, entries })
  )
}

/** Persist-before-request. A retained entry replays the recorded operation id. */
export function getOrCreateQueuedRestoreOperation(
  input: Omit<QueuedRestoreEntry, 'operationId'> & {
    createOperationId: () => string
    now?: number
  }
): Promise<{ operationId: string; retained: boolean }> {
  return serialize(async () => {
    const now = input.now ?? Date.now()
    const entries = await readEntries(now)
    const existing = entries.find((entry) => entry.entryKey === input.entryKey)
    if (existing) {
      return { operationId: existing.operationId, retained: true }
    }
    if (entries.length >= MAX_ENTRIES) {
      throw new Error('Structured restore journal is full')
    }
    const { createOperationId, now: _now, ...held } = input
    const entry = RestoreEntrySchema.parse({ ...held, operationId: createOperationId() })
    await writeEntries([...entries, entry])
    // A write the store dropped without rejecting (the page's `not-delivered`)
    // would leave a handle the settle cannot find, and the text would be lost.
    if (!(await readEntries(now)).some((stored) => stored.entryKey === entry.entryKey)) {
      throw new Error('Structured restore journal did not keep the entry')
    }
    return { operationId: entry.operationId, retained: false }
  })
}

/**
 * Run the restoration exactly once: a concurrent settle of the same entry finds
 * it already gone and does nothing. The entry leaves storage only after
 * `restore` returned, so a crash mid-restore keeps the handle.
 */
export function settleQueuedRestoreOperation(input: {
  entryKey: string
  operationId: string
  restore: (entry: QueuedRestoreEntry) => void | Promise<void>
}): Promise<boolean> {
  return serialize(async () => {
    const entries = await readEntries(Date.now())
    const existing = entries.find((entry) => entry.entryKey === input.entryKey)
    if (!existing || existing.operationId !== input.operationId) {
      return false
    }
    await input.restore(existing)
    await writeEntries(entries.filter((entry) => entry !== existing))
    return true
  })
}

/**
 * Put withdrawn text back once: through the handle when there is one, directly
 * when there is none or the journal failed before restoring — never again after
 * the restore ran, even if removing the entry then failed.
 */
export async function restoreQueuedTextOnce(
  handle: { entryKey: string; operationId: string } | null,
  restore: () => void
): Promise<void> {
  let ran = false
  const once = (): void => {
    if (!ran) {
      ran = true
      restore()
    }
  }
  if (!handle) {
    once()
    return
  }
  await settleQueuedRestoreOperation({ ...handle, restore: once }).catch(once)
}

/** Drop an entry whose operation the host definitively answered without owing text. */
export function discardQueuedRestoreOperation(input: {
  entryKey: string
  operationId: string
}): Promise<void> {
  return serialize(async () => {
    const entries = await readEntries(Date.now())
    const remaining = entries.filter(
      (entry) => !(entry.entryKey === input.entryKey && entry.operationId === input.operationId)
    )
    if (remaining.length !== entries.length) {
      await writeEntries(remaining)
    }
  })
}

/** Panes whose previous-process handles this process already released. */
const relaunchSweptDraftKeys = new Set<string>()

/**
 * Once per app process per pane: release every Stop and /clear handle an
 * earlier process left — never reissued, because a reissue the host never
 * admitted would EXECUTE the command — and hand back the Edit handles to
 * finish. One serialized step, and never again in this process, so it cannot
 * release a handle this process's own in-flight Stop or /clear still settles.
 * Keyed by composer scope: a committed /clear moves the pane to a new session.
 */
export function takeRelaunchQueuedRestoreOperations(input: {
  draftKey: string
  now?: number
}): Promise<QueuedRestoreEntry[]> {
  return serialize(async () => {
    if (relaunchSweptDraftKeys.has(input.draftKey)) {
      return []
    }
    relaunchSweptDraftKeys.add(input.draftKey)
    const entries = await readEntries(input.now ?? Date.now())
    const releases = (entry: QueuedRestoreEntry): boolean =>
      entry.draftKey === input.draftKey && entry.method !== 'agentSession.queuedMessageDelete'
    if (entries.some(releases)) {
      await writeEntries(entries.filter((entry) => !releases(entry)))
    }
    return entries.filter(
      (entry) =>
        entry.draftKey === input.draftKey && entry.method === 'agentSession.queuedMessageDelete'
    )
  })
}

/** Test-only: a fresh app process — serialization drained, relaunch sweep re-armed. */
export function resetQueuedRestoreJournalForTests(): void {
  mutations.tail = Promise.resolve()
  relaunchSweptDraftKeys.clear()
}
