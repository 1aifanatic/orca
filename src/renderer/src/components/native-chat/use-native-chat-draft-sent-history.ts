import { useEffect } from 'react'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import {
  noteNativeChatDraftLatestSend,
  settleHeldNativeChatDraft,
  type NativeChatSentHistory
} from './native-chat-draft-cache'

/**
 * Keeps a structured chat's draft in step with what its host accepted: the newest row seen is
 * saved with the draft, and a draft saved before a relaunch is shown only once the history is
 * read (or cannot be), so text whose send landed but whose clear was lost never comes back.
 */
export function useNativeChatDraftSentHistory(
  draftKey: string | undefined,
  state: StructuredAgentSessionState,
  /** False before the session is published: there is no history to read yet. */
  historyReadable: boolean
): void {
  const { cursor, items, status } = state
  useEffect(() => {
    if (!draftKey) {
      return
    }
    if (!historyReadable || status === 'error') {
      settleHeldNativeChatDraft(draftKey, null)
      return
    }
    if (status !== 'ready' || !cursor) {
      return
    }
    const history: NativeChatSentHistory = {
      latest: cursor,
      sent: items.flatMap((item) =>
        item.body.kind === 'message' && item.body.role === 'user'
          ? [{ sequence: item.sequence, body: item.body }]
          : []
      )
    }
    noteNativeChatDraftLatestSend(draftKey, history.latest)
    settleHeldNativeChatDraft(draftKey, history)
  }, [cursor, draftKey, historyReadable, items, status])
}
