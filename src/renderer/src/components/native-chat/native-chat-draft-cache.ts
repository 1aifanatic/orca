import type { JSONContent } from '@tiptap/react'
// One unsent message (text and image attachments) per chat, shared by every view of that chat and
// saved to disk (native-chat-draft-storage) so it survives quitting Orca. Views mirror it and
// subscribe to changes, so typing in one pane shows in every other pane on the same chat.

import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'
import {
  awaitNativeChatDraftSaved,
  isEmptyNativeChatDraft,
  loadPersistedNativeChatDrafts,
  observeOtherWindowNativeChatDrafts,
  persistNativeChatDraftNow,
  resetNativeChatDraftStorageForTests,
  scheduleNativeChatDraftPersist,
  type NativeChatDraftAttachment,
  type NativeChatDraftWriteResult,
  type NativeChatTuiInputSeed,
  type PersistedNativeChatDraft
} from './native-chat-draft-storage'

export type { NativeChatDraftAttachment, NativeChatDraftWriteResult, NativeChatTuiInputSeed }

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
let hydrated = false

let observingOtherWindows = false

function drafts(): Map<string, DraftEntry> {
  if (!hydrated) {
    hydrated = true
    for (const { scopeKey, draft } of loadPersistedNativeChatDrafts()) {
      draftCache.set(scopeKey, draft)
    }
    if (!observingOtherWindows) {
      observingOtherWindows = true
      // A web client tab must not keep showing, and re-save, text another tab already sent.
      observeOtherWindowNativeChatDrafts((draftKey, draft) => {
        // This window's pending chips never reach disk, so the other window cannot know them.
        const pending = readEntry(draftKey).attachments.filter((chip) => chip.pending)
        const saved = draft ?? { text: '', attachments: EMPTY_ATTACHMENTS }
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
      onEvict: (evicted) => void persistNativeChatDraftNow(evicted, null),
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
    if (drafts().has(draftKey)) {
      setEntry(draftKey, { text: '', attachments: EMPTY_ATTACHMENTS })
    }
    void persistNativeChatDraftNow(draftKey, null)
  }
}

function persistedDraft(draftKey: string): PersistedNativeChatDraft | null {
  const entry = drafts().get(draftKey)
  return entry
    ? {
        ...entry,
        attachments: entry.attachments.flatMap(({ pending, ...attachment }) =>
          pending ? [] : [attachment]
        )
      }
    : null
}

function persistNow(draftKey: string): Promise<NativeChatDraftWriteResult> {
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
    void persistNow(draftKey)
  } else {
    scheduleNativeChatDraftPersist(draftKey, persistedDraft(draftKey))
  }
}

/** Waits (briefly) until the chat's last write, such as the clear at send, is on disk. */
export function awaitNativeChatDraftCleared(draftKey: string): Promise<void> {
  return awaitNativeChatDraftSaved(draftKey)
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
  void persistNow(draftKey)
}

/** The tab's launch draft is gone (sent, resolved, closed), so no pane's input line holds it. */
export function forgetNativeChatTuiInputSeeds(terminalTabId: string): void {
  const prefix = nativeChatDraftKey({ paneKey: `${terminalTabId}:` })
  for (const [draftKey, entry] of Array.from(drafts())) {
    if (draftKey.startsWith(prefix) && entry.tuiInputSeed) {
      const { tuiInputSeed: _gone, ...rest } = entry
      setEntry(draftKey, rest)
      void persistNow(draftKey)
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
  void persistNow(draftKey)
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
): Promise<NativeChatDraftWriteResult> {
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

/** Puts content back only into an empty draft, so nothing the user typed since is touched. */
export async function restoreNativeChatDraftIfEmpty(
  draftKey: string,
  content: NativeChatDraftContent
): Promise<NativeChatDraftWriteResult | 'composer-not-empty'> {
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
