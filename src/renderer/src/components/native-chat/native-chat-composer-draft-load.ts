// Loads every saved draft into memory once at startup, with the journal's unconfirmed changes
// replayed on top. A change made before the load lands is kept: an edit wins over the loaded
// draft, and an append is applied again on top of it.

import {
  dirtyScopes,
  load,
  nextSavedAt,
  notifyScope,
  records,
  unverifiedScopes
} from './native-chat-composer-draft-memory'
import {
  flushNativeChatComposerDrafts,
  installNativeChatComposerDraftBroadcast
} from './native-chat-composer-draft-persistence'
import {
  pruneNativeChatComposerDraftJournal,
  readNativeChatComposerDraftJournal
} from './native-chat-composer-draft-journal'
import {
  nativeChatComposerDraftStorage,
  parseStoredNativeChatComposerDraft,
  removeLegacyLocalStorageNativeChatComposerDrafts,
  type StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

// Why bounded: a database that will not open must not be retried for the whole run; after the
// last try the drafts stay in memory and a refused save shows as one.
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000]

let hydration: Promise<void> | null = null
let failedLoads = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null

function withAppends(scopeKey: string, loaded: StoredNativeChatComposerDraft): DraftLoadResult {
  const pending = load.appendsBeforeLoad.get(scopeKey)
  // Why the time check: a load that read after the append's own write already holds it.
  if (!pending || loaded.savedAt >= pending.firstWrittenAt) {
    return { draft: loaded, changed: false }
  }
  const merged = pending.appends.reduce((draft, append) => append(draft), loaded)
  return { draft: { ...merged, savedAt: nextSavedAt() }, changed: true }
}

type DraftLoadResult = { draft: StoredNativeChatComposerDraft; changed: boolean }

function applyLoaded(loaded: ReadonlyMap<string, unknown>): void {
  const drafts = new Map<string, StoredNativeChatComposerDraft | null>()
  for (const [scopeKey, value] of loaded) {
    drafts.set(scopeKey, parseStoredNativeChatComposerDraft(value))
  }
  for (const [scopeKey, change] of readNativeChatComposerDraftJournal()) {
    const stored = drafts.get(scopeKey)
    if (stored && stored.savedAt >= change.at) {
      pruneNativeChatComposerDraftJournal(scopeKey, change.at)
      continue
    }
    drafts.set(scopeKey, change.draft)
    dirtyScopes.add(scopeKey)
  }
  for (const [scopeKey, stored] of drafts) {
    if (load.editedBeforeLoad.has(scopeKey)) {
      continue
    }
    if (!stored || load.deletionsBeforeLoad.some((matches) => matches(scopeKey, stored))) {
      // An unreadable record, a journaled removal, or one deleted here while loading.
      dirtyScopes.add(scopeKey)
      continue
    }
    const { draft, changed } = withAppends(scopeKey, stored)
    records.set(scopeKey, draft)
    unverifiedScopes.add(scopeKey)
    if (changed) {
      dirtyScopes.add(scopeKey)
    }
    notifyScope(scopeKey)
  }
  load.hydrated = true
  load.editedBeforeLoad.clear()
  load.appendsBeforeLoad.clear()
  load.deletionsBeforeLoad.length = 0
  flushNativeChatComposerDrafts()
}

function retryLater(error: unknown): void {
  if (failedLoads === 0) {
    console.warn('[native-chat-drafts] saved drafts could not be loaded', error)
  }
  const delay = RETRY_DELAYS_MS[failedLoads]
  failedLoads += 1
  if (delay === undefined) {
    // Given up: what was changed meanwhile is all there is, so nothing waits on a load any more.
    load.hydrated = true
    load.editedBeforeLoad.clear()
    load.appendsBeforeLoad.clear()
    load.deletionsBeforeLoad.length = 0
    return
  }
  retryTimer = setTimeout(() => {
    retryTimer = null
    hydration = null
    void hydrateNativeChatComposerDrafts()
  }, delay)
}

/** Loads every saved draft into memory, once; a failed load is retried a few times, then left. */
export function hydrateNativeChatComposerDrafts(): Promise<void> {
  hydration ??= (async () => {
    removeLegacyLocalStorageNativeChatComposerDrafts()
    installNativeChatComposerDraftBroadcast()
    applyLoaded(await nativeChatComposerDraftStorage().loadAll())
  })().catch(retryLater)
  return hydration
}

/** Startup waits this long at most; a load still running fills its drafts in when it lands. */
export async function waitForNativeChatComposerDrafts(timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    hydrateNativeChatComposerDrafts(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
  ])
  clearTimeout(timer)
}

export function resetNativeChatComposerDraftLoadForTests(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  hydration = null
  failedLoads = 0
}
