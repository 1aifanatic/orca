import { useEffect } from 'react'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  noteNativeChatDraftHistoryBaseline,
  settleHeldNativeChatDraft
} from './native-chat-draft-cache'
import {
  draftWasSentAfterSaving,
  draftWasTypedAfterSaving,
  type NativeChatSentHistory
} from './native-chat-draft-sent-match'
import { nativeChatLaunchDraftTurnBaseline } from './native-chat-launch-draft-resolution'
import type { ReadState } from './native-chat-live-session-contract'

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
    noteNativeChatDraftHistoryBaseline(draftKey, { sentBaseline: history.latest })
    settleHeldNativeChatDraft(draftKey, (draft) => draftWasSentAfterSaving(draft, history))
  }, [cursor, draftKey, historyReadable, items, status])
}

/**
 * The same for a chat over a terminal agent, whose sends are only known from the agent's
 * transcript: the user turns seen are saved with the draft (the baseline launch drafts resolve
 * by), and a draft saved before a relaunch waits for the transcript read.
 */
export function useNativeChatPaneDraftTranscript(
  draftKey: string,
  phase: ReadState['phase'],
  messages: readonly NativeChatMessage[]
): void {
  useEffect(() => {
    if (phase === 'loading') {
      return
    }
    // No transcript behind the pane yet, or none readable: nothing proves a send.
    if (phase !== 'ready') {
      settleHeldNativeChatDraft(draftKey, null)
      return
    }
    noteNativeChatDraftHistoryBaseline(draftKey, {
      transcriptBaseline: nativeChatLaunchDraftTurnBaseline([...messages])
    })
    settleHeldNativeChatDraft(draftKey, (draft) => draftWasTypedAfterSaving(draft, messages))
  }, [draftKey, messages, phase])
}
