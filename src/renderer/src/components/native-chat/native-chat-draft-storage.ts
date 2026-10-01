// Disk copy of the composer drafts, so a half-typed message survives quitting Orca.
// Typing is saved after a short delay and flushed when the page hides or closes; a clear or a
// put-back is saved at once, so a crash right after Enter cannot bring back text already sent.

export type NativeChatDraftAttachment = { id: string; path: string; connectionId?: string }

export type PersistedNativeChatDraft = {
  text: string
  attachments: readonly NativeChatDraftAttachment[]
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
    if (!draft || (draft.text === '' && draft.attachments.length === 0)) {
      storage.removeItem(storageKey(scopeKey))
    } else {
      storage.setItem(
        storageKey(scopeKey),
        JSON.stringify({ text: draft.text, attachments: draft.attachments, savedAt: Date.now() })
      )
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
  if (flushListenersInstalled || typeof window === 'undefined') {
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
  if (typeof window === 'undefined') {
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
  const { id, path, connectionId } = value
  if (typeof id !== 'string' || typeof path !== 'string' || path === '') {
    return null
  }
  return typeof connectionId === 'string' ? { id, path, connectionId } : { id, path }
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
    const { text, attachments, savedAt } = value
    if (typeof text !== 'string' || !Array.isArray(attachments)) {
      return null
    }
    const parsed = attachments
      .map(parseAttachment)
      .filter((attachment): attachment is NativeChatDraftAttachment => attachment !== null)
    if (text === '' && parsed.length === 0) {
      return null
    }
    return { text, attachments: parsed, savedAt: typeof savedAt === 'number' ? savedAt : 0 }
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
    return kept.map(([scopeKey, { text, attachments }]) => [scopeKey, { text, attachments }])
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
