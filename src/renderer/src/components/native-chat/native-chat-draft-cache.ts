import type { JSONContent } from '@tiptap/react'
// One unsent message (text and image attachments) per chat, shared by every view of that chat and
// saved to disk (native-chat-draft-storage) so it survives quitting Orca. Views mirror it and
// subscribe to changes, so typing in one pane shows in every other pane on the same chat.

import {
  NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX,
  setBoundedScopeCacheEntry
} from './native-chat-composer-scope-cache'
import {
  isEmptyNativeChatDraft,
  loadPersistedNativeChatDrafts,
  observeOtherWindowNativeChatDrafts,
  persistNativeChatDraftNow,
  resetNativeChatDraftStorageForTests,
  scheduleNativeChatDraftPersist,
  type NativeChatDraftAttachment,
  type NativeChatDraftSentBaseline,
  type NativeChatDraftWriteResult,
  type NativeChatTuiInputSeed,
  type PersistedNativeChatDraft
} from './native-chat-draft-storage'
import { draftWasSentAfterSaving, type NativeChatSentHistory } from './native-chat-draft-sent-match'

export type { NativeChatDraftAttachment, NativeChatDraftWriteResult, NativeChatTuiInputSeed }
export type { NativeChatSentHistory }

/**
 * The chat a draft belongs to. A structured chat is its session, whichever pane shows it. A chat
 * over a terminal agent has no stable session (it changes on `/clear` and on resume), and its
 * agent lives in exactly one pane, so the pane is the chat.
 */
export function nativeChatDraftKey(chat: { sessionId?: string; paneKey: string }): string {
  return chat.sessionId ? `session:${chat.sessionId}` : `pane:${chat.paneKey}`
}

/** A chip in the chat's shared, ordered list; a `pending` one is still being saved and is never written to disk. */
export type NativeChatDraftChip = NativeChatDraftAttachment & { pending?: true }

type DraftEntry = Omit<PersistedNativeChatDraft, 'attachments'> & {
  attachments: readonly NativeChatDraftChip[]
}

const EMPTY_ATTACHMENTS: readonly NativeChatDraftChip[] = []
const draftCache = new Map<string, DraftEntry>()
// Saved drafts that can be checked against what the chat's host accepted; shown only once checked.
const heldDrafts = new Map<string, DraftEntry>()
// The newest host row each chat's view has seen; saved with the draft as its sent baseline.
const latestSeenSends = new Map<string, NativeChatDraftSentBaseline>()
let hydrated = false

let observingOtherWindows = false

function drafts(): Map<string, DraftEntry> {
  if (!hydrated) {
    hydrated = true
    for (const [draftKey, draft] of loadPersistedNativeChatDrafts(
      NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX
    )) {
      if (draft.sentBaseline) {
        heldDrafts.set(draftKey, draft)
      } else {
        draftCache.set(draftKey, draft)
      }
    }
    if (!observingOtherWindows) {
      observingOtherWindows = true
      // A web client tab must not keep showing, and re-save, text another tab already sent.
      observeOtherWindowNativeChatDrafts((draftKey, draft) => {
        // This window's pending chips never reach disk, so the other window cannot know them.
        const pending = readEntry(draftKey).attachments.filter((chip) => chip.pending)
        const saved = draft ?? { text: '', attachments: EMPTY_ATTACHMENTS }
        heldDrafts.delete(draftKey)
        setEntry(draftKey, { ...saved, attachments: [...saved.attachments, ...pending] })
      })
    }
  }
  return draftCache
}

function readEntry(draftKey: string): DraftEntry {
  return drafts().get(draftKey) ?? { text: '', attachments: EMPTY_ATTACHMENTS }
}

const changeListeners = new Map<string, Set<() => void>>()

function setEntry(draftKey: string, entry: DraftEntry): void {
  // An empty draft carries no state worth retaining; drop it so a stale key never resurrects it.
  if (isEmptyNativeChatDraft(entry)) {
    drafts().delete(draftKey)
  } else {
    setBoundedScopeCacheEntry(drafts(), draftKey, entry, {
      onEvict: (evicted) => persistNativeChatDraftNow(evicted, null),
      inUse: (key) => changeListeners.has(key)
    })
  }
  changeListeners.get(draftKey)?.forEach((listener) => listener())
}

/**
 * Deletes the drafts of chats that ended, from memory and disk: a closed structured session,
 * a closed terminal pane, or every pane of a closed terminal tab. None of them comes back
 * (session ids, tab ids and pane leaf ids are never reused), so nothing could show the draft.
 */
export function discardNativeChatDrafts(ended: {
  sessionIds?: Iterable<string>
  paneKeys?: Iterable<string>
  terminalTabIds?: Iterable<string>
}): void {
  const doomed = new Set([
    ...Array.from(ended.sessionIds ?? [], (sessionId) =>
      nativeChatDraftKey({ sessionId, paneKey: '' })
    ),
    ...Array.from(ended.paneKeys ?? [], (paneKey) => nativeChatDraftKey({ paneKey }))
  ])
  const tabPrefixes = Array.from(ended.terminalTabIds ?? [], (tabId) =>
    nativeChatDraftKey({ paneKey: `${tabId}:` })
  )
  if (tabPrefixes.length > 0) {
    for (const draftKey of drafts().keys()) {
      if (tabPrefixes.some((prefix) => draftKey.startsWith(prefix))) {
        doomed.add(draftKey)
      }
    }
  }
  for (const draftKey of doomed) {
    heldDrafts.delete(draftKey)
    if (drafts().has(draftKey)) {
      setEntry(draftKey, { text: '', attachments: EMPTY_ATTACHMENTS })
    }
    persistNativeChatDraftNow(draftKey, null)
  }
}

function persistedDraft(draftKey: string): PersistedNativeChatDraft | null {
  const entry = drafts().get(draftKey)
  const sentBaseline = latestSeenSends.get(draftKey) ?? entry?.sentBaseline
  return entry
    ? {
        ...entry,
        ...(sentBaseline ? { sentBaseline } : {}),
        attachments: entry.attachments.flatMap(({ pending, ...attachment }) =>
          pending ? [] : [attachment]
        )
      }
    : null
}

function persistNow(draftKey: string): NativeChatDraftWriteResult {
  return persistNativeChatDraftNow(draftKey, persistedDraft(draftKey))
}

export function readNativeChatDraftCache(draftKey: string): string {
  return readEntry(draftKey).text
}

/** Typing waits for a pause; a clear (at send) is written at once, even if a put-back remains. */
export function writeNativeChatDraftCache(
  draftKey: string,
  draft: string,
  persist: 'now' | 'after-pause'
): void {
  setEntry(draftKey, { ...readEntry(draftKey), text: draft })
  if (persist === 'now') {
    persistNow(draftKey)
  } else {
    scheduleNativeChatDraftPersist(draftKey, persistedDraft(draftKey))
  }
}

export function readNativeChatDraftTuiInputSeed(
  draftKey: string
): NativeChatTuiInputSeed | undefined {
  return readEntry(draftKey).tuiInputSeed
}

/** What Orca typed into the chat's terminal input line, kept with the draft; written at once. */
export function writeNativeChatDraftTuiInputSeed(
  draftKey: string,
  seed: NativeChatTuiInputSeed
): void {
  setEntry(draftKey, { ...readEntry(draftKey), tuiInputSeed: seed })
  persistNow(draftKey)
}

/** The tab's launch draft is gone (sent, resolved, closed), so no pane's input line holds it. */
export function forgetNativeChatTuiInputSeeds(terminalTabId: string): void {
  const prefix = nativeChatDraftKey({ paneKey: `${terminalTabId}:` })
  for (const [draftKey, entry] of Array.from(drafts())) {
    if (draftKey.startsWith(prefix) && entry.tuiInputSeed) {
      const { tuiInputSeed: _gone, ...rest } = entry
      setEntry(draftKey, rest)
      persistNow(draftKey)
    }
  }
}

export function readNativeChatDraftAttachments(draftKey: string): readonly NativeChatDraftChip[] {
  return readEntry(draftKey).attachments
}

// Every view of the chat edits one ordered list, by chip id, and the result is written at once.
function updateNativeChatDraftAttachments(
  draftKey: string,
  update: (chips: readonly NativeChatDraftChip[]) => readonly NativeChatDraftChip[]
): void {
  const current = readEntry(draftKey)
  setEntry(draftKey, { ...current, attachments: update(current.attachments) })
  persistNow(draftKey)
}

export function addNativeChatDraftAttachments(
  draftKey: string,
  chips: readonly NativeChatDraftChip[]
): void {
  updateNativeChatDraftAttachments(draftKey, (current) => [...current, ...chips])
}

export function removeNativeChatDraftAttachment(draftKey: string, id: string): void {
  updateNativeChatDraftAttachments(draftKey, (current) => current.filter((chip) => chip.id !== id))
}

/** A pending chip's save landed; one removed meanwhile stays removed. */
export function settleNativeChatDraftAttachment(
  draftKey: string,
  settled: NativeChatDraftAttachment
): void {
  updateNativeChatDraftAttachments(draftKey, (current) =>
    current.map((chip) => (chip.id === settled.id ? settled : chip))
  )
}

export function clearNativeChatDraftAttachments(draftKey: string): void {
  updateNativeChatDraftAttachments(draftKey, () => EMPTY_ATTACHMENTS)
}

/** Fires on every change to the chat's draft. */
export function subscribeToNativeChatDraft(draftKey: string, listener: () => void): () => void {
  return subscribe(changeListeners, draftKey, listener)
}

export function appendNativeChatDraftText(draft: string, text: string): string {
  return draft === '' ? text : `${draft.trimEnd()}\n\n${text}`
}

// A composing view cannot show appended text until its IME settles, so it is told what was added.
const textAppendListeners = new Map<string, Set<(text: string) => void>>()

export type NativeChatDraftContent = {
  text: string
  attachments?: readonly NativeChatDraftAttachment[]
}

/**
 * Puts content back after whatever is in the chat's draft, writes it to disk at once, and shows it
 * in every view of the chat. The result says whether it reached disk.
 */
export function appendNativeChatDraftNow(
  draftKey: string,
  content: NativeChatDraftContent
): NativeChatDraftWriteResult {
  const attachments = content.attachments ?? []
  const current = readEntry(draftKey)
  if (content.text !== '') {
    textAppendListeners.get(draftKey)?.forEach((listener) => listener(content.text))
  }
  setEntry(draftKey, {
    ...current,
    text:
      content.text === '' ? current.text : appendNativeChatDraftText(current.text, content.text),
    attachments: [...current.attachments, ...attachments]
  })
  return persistNow(draftKey)
}

export function noteNativeChatDraftLatestSend(
  draftKey: string,
  latest: NativeChatDraftSentBaseline
): void {
  latestSeenSends.set(draftKey, latest)
}

/**
 * Shows a saved draft held at launch, unless the host accepted a message with its exact content
 * after the draft was saved: then the send happened and only its clear was lost (a crash right
 * after Enter), so the draft is dropped for good. `null` history (unreachable, or none to read)
 * restores it, since losing contact is not proof the message was sent.
 */
export function settleHeldNativeChatDraft(
  draftKey: string,
  history: NativeChatSentHistory | null
): void {
  // Loads what was saved, if no view has read it yet.
  drafts()
  const held = heldDrafts.get(draftKey)
  if (!held) {
    return
  }
  heldDrafts.delete(draftKey)
  if (history && draftWasSentAfterSaving(held, history)) {
    // Disk now holds whatever this window has, which no longer includes the sent text.
    persistNow(draftKey)
    return
  }
  if (held.sentBaseline && !latestSeenSends.has(draftKey)) {
    latestSeenSends.set(draftKey, held.sentBaseline)
  }
  appendNativeChatDraftNow(draftKey, { text: held.text, attachments: held.attachments })
}

/** Puts content back only into an empty draft, so nothing the user typed since is touched. */
export function restoreNativeChatDraftIfEmpty(
  draftKey: string,
  content: NativeChatDraftContent
): NativeChatDraftWriteResult | 'composer-not-empty' {
  const current = readEntry(draftKey)
  if (current.text !== '' || current.attachments.length > 0) {
    return 'composer-not-empty'
  }
  return appendNativeChatDraftNow(draftKey, content)
}

function subscribe<T>(
  listenersByKey: Map<string, Set<(value: T) => void>>,
  key: string,
  listener: (value: T) => void
): () => void {
  const listeners = listenersByKey.get(key) ?? new Set()
  listenersByKey.set(key, listeners)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && listenersByKey.get(key) === listeners) {
      listenersByKey.delete(key)
    }
  }
}

export function subscribeToNativeChatDraftAppend(
  draftKey: string,
  listener: (text: string) => void
): () => void {
  return subscribe(textAppendListeners, draftKey, listener)
}

// Rich editor state belongs to the pane's editor, not the chat; memory only.
const documentCache = new Map<string, { text: string; document: JSONContent }>()

/** Clears memory and the saved drafts on disk. */
export function clearNativeChatDraftCacheForTests(): void {
  draftCache.clear()
  heldDrafts.clear()
  latestSeenSends.clear()
  documentCache.clear()
  hydrated = false
  resetNativeChatDraftStorageForTests()
}

export function readNativeChatDraftDocument(
  paneKey: string,
  text: string
): JSONContent | undefined {
  const cached = documentCache.get(paneKey)
  return cached?.text === text ? cached.document : undefined
}

export function writeNativeChatDraftDocument(
  paneKey: string,
  text: string,
  document: JSONContent
): void {
  if (!text) {
    documentCache.delete(paneKey)
    return
  }
  setBoundedScopeCacheEntry(documentCache, paneKey, { text, document })
}
