import { useAppStore } from '@/store'
import { subscribeToStructuredAgentSessionEntriesDelivered } from '@/components/native-chat/structured-agent-session-entry-endings'
import {
  browserAnnotationSendKey,
  diffCommentSendKey,
  noteSendKeyOwner
} from './notes-send-in-flight'

/** Clears the notes a chat message carried from their shelf once the host has the message, by
 *  whichever send or resend got it there, reload included: the send's own callback may be gone. */
export function installNotesSentByChat(): () => void {
  return subscribeToStructuredAgentSessionEntriesDelivered((entry) => {
    const keys = entry.carriedNoteKeys ?? []
    if (keys.length === 0) {
      return
    }
    const sent = new Set(keys)
    const state = useAppStore.getState()
    const worktreeIds = new Set<string>()
    const pageIds = new Set<string>()
    for (const key of keys) {
      const owner = noteSendKeyOwner(key)
      if (owner?.kind === 'diff-comment') {
        worktreeIds.add(owner.owner)
      } else if (owner?.kind === 'browser-annotation') {
        pageIds.add(owner.owner)
      }
    }
    for (const worktreeId of worktreeIds) {
      const notes = state
        .getDiffComments(worktreeId)
        .filter((note) => sent.has(diffCommentSendKey(worktreeId, note)))
      if (notes.length > 0) {
        void state.clearDeliveredDiffComments(worktreeId, notes)
      }
    }
    for (const pageId of pageIds) {
      const annotations = (state.browserAnnotationsByPageId[pageId] ?? []).filter((annotation) =>
        sent.has(browserAnnotationSendKey(annotation))
      )
      if (annotations.length > 0) {
        state.removeDeliveredBrowserPageAnnotations(pageId, annotations)
      }
    }
  })
}
