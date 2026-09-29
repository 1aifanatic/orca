import { useMemo } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  nativeChatTurnMembership,
  type NativeChatTurnMembership
} from '../../../../shared/native-chat-turn-membership'

/** Each row's turn, and which turn is live, resolved once: from the turn record when the host
 *  states scopes, else by journal order. */
export function useNativeChatTurnMembership(
  messages: readonly NativeChatMessage[],
  journalItems: readonly AgentJournalRenderItem[] | undefined,
  journalSubmissions: readonly AgentJournalSubmission[] | undefined
): NativeChatTurnMembership {
  return useMemo(
    () =>
      nativeChatTurnMembership(
        messages,
        journalItems ? { items: journalItems, submissions: journalSubmissions ?? [] } : null
      ),
    [journalItems, journalSubmissions, messages]
  )
}
