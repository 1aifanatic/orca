import { useAppStore } from '@/store'
import { subscribeToStructuredAgentSessionCarriedNotesSpent } from '@/components/native-chat/structured-agent-session-outbox-carried-notes'
import {
  browserAnnotationSendKey,
  diffCommentSendKey,
  noteSendKeyOwner
} from './notes-send-in-flight'

let uninstall: (() => void) | null = null

/** A new chat's message sent on, by its own start, a Retry or a re-check, clears the notes it
 *  carries from their shelf as a delivered send does, including after a reload. Once per renderer. */
export function installNotesDeliveredByChat(): void {
  if (uninstall) {
    return
  }
  uninstall = subscribeToStructuredAgentSessionCarriedNotesSpent((keys) => {
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
        .filter((note) => sent.has(diffCommentSendKey(note)))
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

import.meta.hot?.dispose(() => {
  uninstall?.()
  uninstall = null
})
