import { useAppStore } from '@/store'
import { subscribeToStructuredAgentSessionEntryEndings } from '@/components/native-chat/structured-agent-session-entry-endings'
import {
  browserAnnotationSendKey,
  diffCommentSendKey,
  noteSendKeyOwner
} from './notes-send-in-flight'

// Why: notes follow their text, so they have one owner. Once a chat message carrying them reaches
// the host, or its text goes back to the composer, they are used and leave their shelf; only a
// message thrown away with nothing handed back leaves them there. A note not loaded yet when that
// happens (its workspace or page hydrates later) is cleared when it loads, never forgotten.
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

/** Clears the pending notes the store now holds, and forgets each one it cleared. */
function clearLoadedNotes(): void {
  const state = useAppStore.getState()
  for (const [ownerId, parsed] of pendingByOwner) {
    const { keys } = parsed
    const current =
      parsed.kind === 'diff-comment'
        ? state.getDiffComments(parsed.owner)
        : state.browserAnnotationsByPageId[parsed.owner]
    if (current === parsed.seen) {
      continue
    }
    parsed.seen = current
    if (parsed.kind === 'diff-comment') {
      const notes = state
        .getDiffComments(parsed.owner)
        .filter((note) => keys.has(diffCommentSendKey(parsed.owner, note)))
      for (const note of notes) {
        keys.delete(diffCommentSendKey(parsed.owner, note))
      }
      if (notes.length > 0) {
        void state.clearDeliveredDiffComments(parsed.owner, notes)
      }
    } else {
      const annotations = (state.browserAnnotationsByPageId[parsed.owner] ?? []).filter(
        (annotation) => keys.has(browserAnnotationSendKey(annotation))
      )
      for (const annotation of annotations) {
        keys.delete(browserAnnotationSendKey(annotation))
      }
      if (annotations.length > 0) {
        state.removeDeliveredBrowserPageAnnotations(parsed.owner, annotations)
      }
    }
    if (keys.size === 0) {
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
    clearWhenLoaded()
  })
  return () => {
    unsubscribeEndings()
    unsubscribeStore?.()
    unsubscribeStore = null
    pendingByOwner.clear()
  }
}
