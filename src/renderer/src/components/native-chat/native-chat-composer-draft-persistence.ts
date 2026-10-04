// Keeps storage a copy of the draft store's memory: writes each changed draft whole, loads every
// draft once at startup, journals what storage has not confirmed when the window goes away, and
// follows other windows' writes.

import { basename } from '@/lib/path'
import { isNativeChatKeptPastePath, isNativeChatPastedImagePath } from './native-chat-image-paste'
import {
  dirtyScopes,
  hasLocalChange,
  nextSavedAt,
  notifyScope,
  records,
  refusedScopes,
  unconfirmed,
  unverifiedScopes,
  type DraftRecord,
  type UnconfirmedDraftChange
} from './native-chat-composer-draft-memory'
import {
  nativeChatComposerDraftStorage,
  parseStoredNativeChatComposerDraft,
  removeLegacyLocalStorageNativeChatComposerDrafts,
  type NativeChatComposerDraftImage,
  type StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

const PERSIST_DEBOUNCE_MS = 250
const JOURNAL_KEY = 'orca:nativeChatComposerDraftJournal:v1'
const CHANNEL_NAME = 'orca-native-chat-composer-drafts'

let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushOnHideInstalled = false
let journaled = false
const inFlight = new Set<Promise<void>>()
let channel: BroadcastChannel | null = null

let hydrated = false
let hydration: Promise<void> | null = null
// Before the load lands, a scope changed here keeps its local version, and a deletion here also
// applies to what the load brings.
const touchedBeforeLoad = new Set<string>()
const deletionsBeforeLoad: ((scopeKey: string, draft: StoredNativeChatComposerDraft) => boolean)[] =
  []

/** An image the draft names but can no longer send, so the user can attach it again. */
export function unavailableNativeChatComposerDraftImage(
  image: NativeChatComposerDraftImage
): NativeChatComposerDraftImage {
  return image.unavailableName === undefined
    ? { id: image.id, path: '', unavailableName: basename(image.path) }
    : image
}

/** A local paste in Orca's paste folder: it outlives the run, so a restore can show and send it. */
export function isKeptLocalPaste(image: NativeChatComposerDraftImage): boolean {
  return !image.connectionId && isNativeChatKeptPastePath(image.path)
}

/** What storage keeps: not an unsaved launch-seed copy, and a paste outside Orca's paste folder
 *  (over SSH, or from before it) only by name. Null when nothing is left. */
function savedForm(record: DraftRecord): StoredNativeChatComposerDraft | null {
  const { unsavedText, ...saved } = record
  const images = saved.images.map((image) =>
    isNativeChatPastedImagePath(image.path) && !isKeptLocalPaste(image)
      ? unavailableNativeChatComposerDraftImage(image)
      : image
  )
  const text = saved.text === unsavedText ? '' : saved.text
  if (text === '' && images.length === 0) {
    return null
  }
  return { ...saved, text, images }
}

function clearJournalIfSettled(): void {
  if (!journaled || unconfirmed.size > 0) {
    return
  }
  journaled = false
  try {
    localStorage.removeItem(JOURNAL_KEY)
  } catch {
    // Nothing to clear without localStorage.
  }
}

function confirm(scopeKey: string, change: UnconfirmedDraftChange): void {
  if (unconfirmed.get(scopeKey) === change) {
    unconfirmed.delete(scopeKey)
    if (refusedScopes.delete(scopeKey)) {
      notifyScope(scopeKey)
    }
    clearJournalIfSettled()
  }
  channel?.postMessage({ scopeKey })
}

function refuse(scopeKey: string, change: UnconfirmedDraftChange, error: unknown): void {
  if (unconfirmed.get(scopeKey) !== change) {
    return
  }
  unconfirmed.delete(scopeKey)
  dirtyScopes.add(scopeKey)
  if (!refusedScopes.has(scopeKey)) {
    console.warn('[native-chat-drafts] a draft could not be saved; it is kept in memory', error)
    refusedScopes.add(scopeKey)
    notifyScope(scopeKey)
  }
}

function persist(scopeKey: string): void {
  const record = records.get(scopeKey)
  const draft = record ? savedForm(record) : null
  const change: UnconfirmedDraftChange = { draft, at: draft?.savedAt ?? nextSavedAt() }
  unconfirmed.set(scopeKey, change)
  const storage = nativeChatComposerDraftStorage()
  const written = (draft ? storage.write(scopeKey, draft) : storage.remove([scopeKey])).then(
    () => confirm(scopeKey, change),
    (error: unknown) => refuse(scopeKey, change, error)
  )
  inFlight.add(written)
  void written.finally(() => inFlight.delete(written))
}

export function flushNativeChatComposerDrafts(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!hydrated) {
    // Why: a load that failed is retried, so a later one can still bring the drafts back.
    void hydrateNativeChatComposerDrafts()
  }
  for (const scopeKey of dirtyScopes) {
    dirtyScopes.delete(scopeKey)
    persist(scopeKey)
  }
}

/** Why: storage commits after this task, so whatever it has not confirmed when the window goes
 *  away is also written here synchronously and replayed by the next run. */
function journalUnconfirmed(): void {
  flushNativeChatComposerDrafts()
  try {
    if (unconfirmed.size === 0) {
      clearJournalIfSettled()
      return
    }
    const entries = [...unconfirmed].map(([scopeKey, change]) => ({ scopeKey, ...change }))
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries))
    journaled = true
  } catch {
    // A full localStorage loses only what storage itself had not yet confirmed.
  }
}

function journalWhenHidden(): void {
  if (document.visibilityState === 'hidden') {
    journalUnconfirmed()
  }
}

function installFlushOnHide(): void {
  if (
    flushOnHideInstalled ||
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function' ||
    typeof document === 'undefined'
  ) {
    return
  }
  flushOnHideInstalled = true
  window.addEventListener('pagehide', journalUnconfirmed)
  window.addEventListener('beforeunload', journalUnconfirmed)
  document.addEventListener('visibilitychange', journalWhenHidden)
}

/** Marks a scope changed in memory: `deferred` coalesces typing into one write, `immediate`
 *  writes now. */
export function persistNativeChatComposerDraft(
  scopeKey: string,
  persist: 'immediate' | 'deferred'
): void {
  dirtyScopes.add(scopeKey)
  if (!hydrated) {
    touchedBeforeLoad.add(scopeKey)
  }
  installFlushOnHide()
  if (persist === 'immediate') {
    flushNativeChatComposerDrafts()
    return
  }
  flushTimer ??= setTimeout(flushNativeChatComposerDrafts, PERSIST_DEBOUNCE_MS)
}

/** A deletion also applies to drafts a load still in flight brings back. */
export function deleteLoadingNativeChatComposerDraftsWhere(
  matches: (scopeKey: string, draft: StoredNativeChatComposerDraft) => boolean
): void {
  if (!hydrated) {
    deletionsBeforeLoad.push(matches)
  }
}

function readJournal(): Map<string, UnconfirmedDraftChange> {
  const journal = new Map<string, UnconfirmedDraftChange>()
  try {
    const entries: unknown = JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? '[]')
    journaled = Array.isArray(entries) && entries.length > 0
    for (const entry of Array.isArray(entries) ? entries : []) {
      const { scopeKey, draft, at } = entry ?? {}
      if (typeof scopeKey === 'string' && typeof at === 'number') {
        journal.set(scopeKey, { draft: parseStoredNativeChatComposerDraft(draft), at })
      }
    }
  } catch {
    // An unreadable journal holds nothing to replay.
  }
  return journal
}

function applyLoaded(loaded: ReadonlyMap<string, unknown>): void {
  const drafts = new Map<string, StoredNativeChatComposerDraft | null>()
  for (const [scopeKey, value] of loaded) {
    drafts.set(scopeKey, parseStoredNativeChatComposerDraft(value))
  }
  for (const [scopeKey, change] of readJournal()) {
    const stored = drafts.get(scopeKey)
    if (!stored || stored.savedAt < change.at) {
      drafts.set(scopeKey, change.draft)
      dirtyScopes.add(scopeKey)
    }
  }
  for (const [scopeKey, draft] of drafts) {
    if (touchedBeforeLoad.has(scopeKey)) {
      continue
    }
    if (!draft || deletionsBeforeLoad.some((matches) => matches(scopeKey, draft))) {
      // An unreadable record, a journaled removal, or one deleted here while loading.
      dirtyScopes.add(scopeKey)
      continue
    }
    records.set(scopeKey, draft)
    unverifiedScopes.add(scopeKey)
    notifyScope(scopeKey)
  }
  hydrated = true
  touchedBeforeLoad.clear()
  deletionsBeforeLoad.length = 0
  flushNativeChatComposerDrafts()
  clearJournalIfSettled()
}

// Why: another window of the same app (two web-client tabs) can send or edit this draft; its write
// replaces what this window holds unless this window has a change of its own not yet saved.
function adoptForeignChange(message: unknown): void {
  const scopeKey =
    typeof message === 'object' && message !== null && 'scopeKey' in message
      ? message.scopeKey
      : null
  if (typeof scopeKey !== 'string' || hasLocalChange(scopeKey)) {
    return
  }
  void nativeChatComposerDraftStorage()
    .read(scopeKey)
    .then((value) => {
      if (hasLocalChange(scopeKey)) {
        return
      }
      const draft = parseStoredNativeChatComposerDraft(value)
      if (draft) {
        records.set(scopeKey, draft)
        unverifiedScopes.add(scopeKey)
      } else {
        records.delete(scopeKey)
      }
      notifyScope(scopeKey)
    })
    .catch(() => {})
}

function installBroadcast(): void {
  if (channel || typeof BroadcastChannel === 'undefined') {
    return
  }
  channel = new BroadcastChannel(CHANNEL_NAME)
  channel.onmessage = (event) => adoptForeignChange(event.data)
  // Why: Node's channel (unit tests) would otherwise keep the process alive.
  if ('unref' in channel && typeof channel.unref === 'function') {
    channel.unref()
  }
}

/** Loads every saved draft into memory, once; a failed load is retried by the next flush. */
export function hydrateNativeChatComposerDrafts(): Promise<void> {
  hydration ??= (async () => {
    removeLegacyLocalStorageNativeChatComposerDrafts()
    installBroadcast()
    applyLoaded(await nativeChatComposerDraftStorage().loadAll())
  })().catch((error: unknown) => {
    console.warn('[native-chat-drafts] saved drafts could not be loaded', error)
    hydration = null
  })
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

/** Settles once every write issued so far has been confirmed or refused. */
export async function nativeChatComposerDraftWritesSettled(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled(inFlight)
  }
}

export function resetNativeChatComposerDraftPersistenceForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  channel?.close()
  channel = null
  if (flushOnHideInstalled) {
    flushOnHideInstalled = false
    window.removeEventListener('pagehide', journalUnconfirmed)
    window.removeEventListener('beforeunload', journalUnconfirmed)
    document.removeEventListener('visibilitychange', journalWhenHidden)
  }
  hydrated = false
  hydration = null
  journaled = false
  touchedBeforeLoad.clear()
  deletionsBeforeLoad.length = 0
  inFlight.clear()
}
