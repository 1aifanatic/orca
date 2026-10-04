import { useAppStore } from '@/store'
import { subscribeToStructuredAgentSessionEntryEndings } from '@/components/native-chat/structured-agent-session-entry-endings'
import {
  browserAnnotationSendKey,
  diffCommentSendKey,
  noteSendKeyOwner
} from './notes-send-in-flight'

// Why: notes follow their text, so they have one owner. Once a chat message carrying them reaches
// the host, or its text goes back to the composer, they are used and leave their shelf; only a
// message thrown away with nothing handed back leaves them there. A note whose workspace has not
// loaded yet when that happens is cleared when it loads. Once its owner is loaded, a key with no
// note (already cleared, edited since, or its workspace or page gone) is dropped: nothing waits on
// a note that can no longer appear.
type PendingNotes = {
  kind: 'diff-comment' | 'browser-annotation'
  owner: string
  keys: Set<string>
  /** The owner's notes as last looked at, so an unrelated store change reads nothing again. */
  seen: unknown
}
const NOT_SEEN = Symbol('not seen')
const pendingByOwner = new Map<string, PendingNotes>()
let unsubscribeStore: (() => void) | null = null

function ownerKey(kind: 'diff-comment' | 'browser-annotation', owner: string): string {
  return JSON.stringify([kind, owner])
}

type StoreState = ReturnType<typeof useAppStore.getState>

/** Whether the owner's notes are in the store as they will be: a workspace's arrive with the
 *  session's hydration; a page's annotations live only in memory, so they are there or gone. */
function ownerLoaded(state: StoreState, pending: PendingNotes): boolean {
  return (
    pending.kind === 'browser-annotation' ||
    state.workspaceSessionReady ||
    state.getDiffComments(pending.owner).length > 0
  )
}

/** Clears the pending notes the store now holds; drops what a loaded owner no longer has. */
function clearLoadedNotes(): void {
  const state = useAppStore.getState()
  for (const [ownerId, pending] of pendingByOwner) {
    const { keys } = pending
    const loaded = ownerLoaded(state, pending)
    const current =
      pending.kind === 'diff-comment'
        ? state.getDiffComments(pending.owner)
        : state.browserAnnotationsByPageId[pending.owner]
    if (!loaded && current === pending.seen) {
      continue
    }
    pending.seen = current
    if (pending.kind === 'diff-comment') {
      const notes = state
        .getDiffComments(pending.owner)
        .filter((note) => keys.has(diffCommentSendKey(pending.owner, note)))
      if (notes.length > 0) {
        void state.clearDeliveredDiffComments(pending.owner, notes)
      }
      for (const note of notes) {
        keys.delete(diffCommentSendKey(pending.owner, note))
      }
    } else {
      const annotations = (state.browserAnnotationsByPageId[pending.owner] ?? []).filter(
        (annotation) => keys.has(browserAnnotationSendKey(annotation))
      )
      if (annotations.length > 0) {
        state.removeDeliveredBrowserPageAnnotations(pending.owner, annotations)
      }
      for (const annotation of annotations) {
        keys.delete(browserAnnotationSendKey(annotation))
      }
    }
    if (loaded || keys.size === 0) {
      pendingByOwner.delete(ownerId)
    }
  }
}

let clearing = false
function clearWhenLoaded(): void {
  // A clear changes the store, which calls back here.
  if (clearing) {
    return
  }
  clearing = true
  try {
    clearLoadedNotes()
  } finally {
    clearing = false
  }
  if (pendingByOwner.size === 0) {
    unsubscribeStore?.()
    unsubscribeStore = null
  } else if (!unsubscribeStore) {
    unsubscribeStore = useAppStore.subscribe(clearWhenLoaded)
  }
}

/** Clears the notes a chat message carried once it is used: the host has it, or its text went
 *  back to the composer. By whichever send, resend or Stop ended it, reload included. */
export function installNotesSentByChat(): () => void {
  const unsubscribeEndings = subscribeToStructuredAgentSessionEntryEndings((entry, ending) => {
    if (ending === 'discarded') {
      return
    }
    for (const key of entry.carriedNoteKeys ?? []) {
      const parsed = noteSendKeyOwner(key)
      if (parsed) {
        const ownerId = ownerKey(parsed.kind, parsed.owner)
        const pending = pendingByOwner.get(ownerId) ?? {
          ...parsed,
          keys: new Set<string>(),
          seen: NOT_SEEN
        }
        pendingByOwner.set(ownerId, pending)
        pending.keys.add(key)
        pending.seen = NOT_SEEN
      }
    }
    // An ending can fire inside a store update (a removed workspace's chats settle there), and a
    // clear written into it could be overwritten by that update's own result.
    queueMicrotask(clearWhenLoaded)
  })
  return () => {
    unsubscribeEndings()
    unsubscribeStore?.()
    unsubscribeStore = null
    pendingByOwner.clear()
  }
}
