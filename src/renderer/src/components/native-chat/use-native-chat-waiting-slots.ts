import { useMemo } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import {
  splitNativeChatSlotsWaitingBehindLiveTurn,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'

/** The slots drawn in the list, and those of messages waiting behind the live turn, drawn after
 *  its live activity (`splitNativeChatSlotsWaitingBehindLiveTurn`). */
export function useNativeChatWaitingSlots(
  allSlots: readonly NativeChatTranscriptSlot[],
  journalItems: readonly AgentJournalRenderItem[] | undefined,
  stopping: boolean,
  journalSubmissions: readonly AgentJournalSubmission[] | undefined
): { slots: NativeChatTranscriptSlot[]; waitingSlots: NativeChatTranscriptSlot[] } {
  return useMemo(
    () =>
      splitNativeChatSlotsWaitingBehindLiveTurn(
        allSlots,
        journalItems,
        stopping,
        journalSubmissions
      ),
    [allSlots, journalItems, stopping, journalSubmissions]
  )
}
