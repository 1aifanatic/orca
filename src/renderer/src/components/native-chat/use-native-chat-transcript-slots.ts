import { useMemo } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import {
  buildNativeChatTranscriptSlots,
  splitNativeChatSlotsWaitingBehindLiveTurn,
  type NativeChatTranscriptSlot,
  type NativeChatTranscriptSlotsInput
} from './native-chat-transcript-slots'

/** The list's slots, and those of messages waiting behind the live turn, drawn after its live
 *  activity (`splitNativeChatSlotsWaitingBehindLiveTurn`). */
export function useNativeChatTranscriptSlots(
  input: NativeChatTranscriptSlotsInput & {
    journalItems: readonly AgentJournalRenderItem[] | undefined
    journalSubmissions: readonly AgentJournalSubmission[] | undefined
    stopping: boolean
  }
): { slots: NativeChatTranscriptSlot[]; waitingSlots: NativeChatTranscriptSlot[] } {
  const {
    messages,
    typography,
    turnKeys,
    liveTurnKey,
    receipts,
    turnStatuses,
    turnDiffs,
    expandedTurnKeys,
    isWorking,
    lifecycleWorking,
    subagentSections,
    subagentChoices,
    journalItems,
    journalSubmissions,
    stopping
  } = input
  const allSlots = useMemo(
    () =>
      buildNativeChatTranscriptSlots({
        messages,
        typography,
        turnKeys,
        liveTurnKey,
        receipts,
        turnStatuses,
        turnDiffs,
        expandedTurnKeys,
        isWorking,
        lifecycleWorking,
        subagentSections,
        subagentChoices
      }),
    [
      messages,
      typography,
      turnKeys,
      liveTurnKey,
      receipts,
      turnStatuses,
      turnDiffs,
      expandedTurnKeys,
      isWorking,
      lifecycleWorking,
      subagentSections,
      subagentChoices
    ]
  )
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
