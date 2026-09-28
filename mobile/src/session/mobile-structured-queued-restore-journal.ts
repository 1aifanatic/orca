// Write-ahead persistence for the mutations that owe the composer text back:
// a Stop that withdraws queued drafts, and an Edit that deletes one to reclaim
// its body. The operation identity is persisted BEFORE the RPC — the order the
// send journal already establishes — so a crash after the host withdrew but
// before the text reached the composer keeps a replay handle: reissuing the
// same operation id answers from the host's tombstone receipts. An entry is
// removed only after its restoration ran (or the host definitively refused),
// and every entry dies on its own once the host's replay window has passed.

import AsyncStorage from '@react-native-async-storage/async-storage'
import { z } from 'zod'
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
  if (entries.length === 0) {
    await AsyncStorage.removeItem(STORAGE_KEY)
    return
  }
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, entries }))
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

/** Unsettled obligations for one chat, expired handles already pruned. */
export function listQueuedRestoreOperations(input: {
  sessionKey: string
  now?: number
}): Promise<QueuedRestoreEntry[]> {
  return serialize(async () => {
    const entries = await readEntries(input.now ?? Date.now())
    return entries.filter((entry) => entry.sessionKey === input.sessionKey)
  })
}

/** Test-only: drain in-memory serialization while preserving durable storage. */
export function resetQueuedRestoreJournalForTests(): void {
  mutations.tail = Promise.resolve()
}
