// Disk copy of the composer drafts, so a half-typed message survives quitting Orca.
// Typing is saved after a short delay and flushed when the page hides or closes; a clear or a
// put-back is saved at once, so a crash right after Enter cannot bring back text already sent.

import type { TuiAgent } from '../../../../shared/tui-agent'
import type { NativeChatLaunchDraftTurnBaseline } from './native-chat-launch-draft-resolution'
import { isTuiAgent } from '../../../../shared/tui-agent-config'

/**
 * Where an image's file lives: on this machine, on an SSH host (`connectionId`), or on a runtime
 * server. Chips saved before this was recorded have none, and are treated as unknown.
 */
export type NativeChatDraftAttachmentLocation = 'local' | 'ssh' | 'runtime'

export type NativeChatDraftAttachment = {
  id: string
  path: string
  connectionId?: string
  location?: NativeChatDraftAttachmentLocation
}

const ATTACHMENT_LOCATIONS: readonly unknown[] = ['local', 'ssh', 'runtime']

function isAttachmentLocation(value: unknown): value is NativeChatDraftAttachmentLocation {
  return ATTACHMENT_LOCATIONS.includes(value)
}

/** Launch text Orca typed into a terminal agent's input line, which still holds it. */
export type NativeChatTuiInputSeed = { agent: TuiAgent; text: string; createdAt: number }

/**
 * The newest message the host had accepted in the chat, in host order, as this client saw it when
 * the draft was saved; `sequence` 0 when it had seen none. A message the host accepted after it
 * with the draft's own content was sent from this draft, even if the draft's clear never landed.
 */
export type NativeChatDraftSentBaseline = { epoch: string; sequence: number }

export type PersistedNativeChatDraft = {
  text: string
  attachments: readonly NativeChatDraftAttachment[]
  tuiInputSeed?: NativeChatTuiInputSeed
  sentBaseline?: NativeChatDraftSentBaseline
  /** A chat over a terminal agent: its transcript's user turns as seen when the draft was saved. */
  transcriptBaseline?: NativeChatLaunchDraftTurnBaseline
}

/** What a chat's view has seen of its history, saved with the draft as it is written. */
export type NativeChatDraftHistoryBaseline = Pick<
  PersistedNativeChatDraft,
  'sentBaseline' | 'transcriptBaseline'
>

export function isEmptyNativeChatDraft(draft: PersistedNativeChatDraft): boolean {
  return draft.text === '' && draft.attachments.length === 0 && !draft.tuiInputSeed
}

/** Whether a write reached disk; a `memory-only` draft is lost when Orca quits. */
export type NativeChatDraftWriteResult = 'persisted' | 'memory-only'

const DRAFT_PREFIX = 'orca:nativeChatComposerDraft:v1:'
const TYPING_PERSIST_DELAY_MS = 300

const pendingDrafts = new Map<string, PersistedNativeChatDraft | null>()
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
let flushListenersInstalled = false

function storageKey(scopeKey: string): string {
  return `${DRAFT_PREFIX}${encodeURIComponent(scopeKey)}`
}

function draftStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function writeToStorage(
  scopeKey: string,
  draft: PersistedNativeChatDraft | null
): NativeChatDraftWriteResult {
  const storage = draftStorage()
  if (!storage) {
    return 'memory-only'
  }
  try {
    if (!draft || isEmptyNativeChatDraft(draft)) {
      storage.removeItem(storageKey(scopeKey))
    } else {
      storage.setItem(storageKey(scopeKey), JSON.stringify({ ...draft, savedAt: Date.now() }))
    }
    return 'persisted'
  } catch {
    return 'memory-only'
  }
}

function cancelPending(scopeKey: string): void {
  const timer = pendingTimers.get(scopeKey)
  if (timer !== undefined) {
    clearTimeout(timer)
    pendingTimers.delete(scopeKey)
  }
  pendingDrafts.delete(scopeKey)
}

/** Writes now, superseding any delayed write for the scope. `null` removes the saved draft. */
export function persistNativeChatDraftNow(
  scopeKey: string,
  draft: PersistedNativeChatDraft | null
): NativeChatDraftWriteResult {
  cancelPending(scopeKey)
  return writeToStorage(scopeKey, draft)
}

export function flushNativeChatDraftPersists(): void {
  for (const [scopeKey, draft] of Array.from(pendingDrafts)) {
    persistNativeChatDraftNow(scopeKey, draft)
  }
}

function installFlushListeners(): void {
  if (
    flushListenersInstalled ||
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function'
  ) {
    return
  }
  flushListenersInstalled = true
  window.addEventListener('pagehide', flushNativeChatDraftPersists)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushNativeChatDraftPersists()
    }
  })
}

/** Saves typing after a short pause; the latest draft wins. */
export function scheduleNativeChatDraftPersist(
  scopeKey: string,
  draft: PersistedNativeChatDraft | null
): void {
  installFlushListeners()
  const timer = pendingTimers.get(scopeKey)
  if (timer !== undefined) {
    clearTimeout(timer)
  }
  pendingDrafts.set(scopeKey, draft)
  pendingTimers.set(
    scopeKey,
    setTimeout(
      () => persistNativeChatDraftNow(scopeKey, pendingDrafts.get(scopeKey) ?? null),
      TYPING_PERSIST_DELAY_MS
    )
  )
}

/**
 * Calls back when another window of this origin (a second browser tab of the web client) changes
 * a saved draft. A key with a write still pending here is skipped: this window's draft is newer.
 */
export function observeOtherWindowNativeChatDrafts(
  onChange: (scopeKey: string, draft: PersistedNativeChatDraft | null) => void
): void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return
  }
  window.addEventListener('storage', (event) => {
    if (!event.key?.startsWith(DRAFT_PREFIX)) {
      return
    }
    const scopeKey = decodeURIComponent(event.key.slice(DRAFT_PREFIX.length))
    if (!pendingDrafts.has(scopeKey)) {
      onChange(scopeKey, parseStoredDraft(event.newValue))
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseAttachment(value: unknown): NativeChatDraftAttachment | null {
  if (!isRecord(value)) {
    return null
  }
  const { id, path, connectionId, location } = value
  if (typeof id !== 'string' || typeof path !== 'string' || path === '') {
    return null
  }
  return {
    id,
    path,
    ...(typeof connectionId === 'string' ? { connectionId } : {}),
    ...(isAttachmentLocation(location) ? { location } : {})
  }
}

function parseTuiInputSeed(value: unknown): { tuiInputSeed?: NativeChatTuiInputSeed } {
  if (!isRecord(value)) {
    return {}
  }
  const { agent, text, createdAt } = value
  return isTuiAgent(agent) &&
    typeof text === 'string' &&
    text !== '' &&
    typeof createdAt === 'number'
    ? { tuiInputSeed: { agent, text, createdAt } }
    : {}
}

function parseSentBaseline(value: unknown): { sentBaseline?: NativeChatDraftSentBaseline } {
  if (!isRecord(value)) {
    return {}
  }
  const { epoch, sequence } = value
  return typeof epoch === 'string' && typeof sequence === 'number'
    ? { sentBaseline: { epoch, sequence } }
    : {}
}

function parseTranscriptBaseline(value: unknown): {
  transcriptBaseline?: NativeChatLaunchDraftTurnBaseline
} {
  if (!isRecord(value)) {
    return {}
  }
  const { userTurnCount, lastUserTurnId } = value
  return typeof userTurnCount === 'number' &&
    (typeof lastUserTurnId === 'string' || lastUserTurnId === null)
    ? { transcriptBaseline: { userTurnCount, lastUserTurnId } }
    : {}
}

function parseStoredDraft(
  raw: string | null
): (PersistedNativeChatDraft & { savedAt: number }) | null {
  if (!raw) {
    return null
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value)) {
      return null
    }
    const { text, attachments, tuiInputSeed, sentBaseline, transcriptBaseline, savedAt } = value
    if (typeof text !== 'string' || !Array.isArray(attachments)) {
      return null
    }
    const draft = {
      text,
      attachments: attachments
        .map(parseAttachment)
        .filter((attachment): attachment is NativeChatDraftAttachment => attachment !== null),
      ...parseTuiInputSeed(tuiInputSeed),
      ...parseSentBaseline(sentBaseline),
      ...parseTranscriptBaseline(transcriptBaseline)
    }
    return isEmptyNativeChatDraft(draft)
      ? null
      : { ...draft, savedAt: typeof savedAt === 'number' ? savedAt : 0 }
  } catch {
    return null
  }
}

/**
 * Reads every saved draft, oldest first, keeping the newest `limit`. Unreadable entries and those
 * past the limit are deleted, so drafts of panes that no longer exist cannot pile up on disk.
 */
export function loadPersistedNativeChatDrafts(
  limit: number
): [scopeKey: string, draft: PersistedNativeChatDraft][] {
  const storage = draftStorage()
  if (!storage) {
    return []
  }
  try {
    const loaded: [string, PersistedNativeChatDraft & { savedAt: number }][] = []
    const discarded: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (!key?.startsWith(DRAFT_PREFIX)) {
        continue
      }
      const draft = parseStoredDraft(storage.getItem(key))
      if (draft) {
        loaded.push([decodeURIComponent(key.slice(DRAFT_PREFIX.length)), draft])
      } else {
        discarded.push(key)
      }
    }
    loaded.sort((left, right) => left[1].savedAt - right[1].savedAt)
    const kept = loaded.slice(Math.max(0, loaded.length - limit))
    for (const [scopeKey] of loaded.slice(0, loaded.length - kept.length)) {
      discarded.push(storageKey(scopeKey))
    }
    for (const key of discarded) {
      storage.removeItem(key)
    }
    return kept.map(([scopeKey, { savedAt: _savedAt, ...draft }]) => [scopeKey, draft])
  } catch {
    return []
  }
}

export function resetNativeChatDraftStorageForTests(): void {
  for (const scopeKey of Array.from(pendingTimers.keys())) {
    cancelPending(scopeKey)
  }
  pendingDrafts.clear()
  const storage = draftStorage()
  if (!storage) {
    return
  }
  try {
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(DRAFT_PREFIX)) {
        keys.push(key)
      }
    }
    keys.forEach((key) => storage.removeItem(key))
  } catch {
    // Storage that cannot be read holds nothing to reset.
  }
}
