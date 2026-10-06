import { useMemo } from 'react'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import {
  splitNativeChatSlotsWaitingBehindLiveTurn,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'

/** A message waiting behind the live turn draws after that turn's live activity, not inside it. */
export function useNativeChatWaitingSlots(
  allSlots: readonly NativeChatTranscriptSlot[],
  journalItems: readonly AgentJournalRenderItem[] | undefined,
  stopping: boolean
): { slots: NativeChatTranscriptSlot[]; waitingSlots: NativeChatTranscriptSlot[] } {
  return useMemo(
    () => splitNativeChatSlotsWaitingBehindLiveTurn(allSlots, journalItems, stopping),
    [allSlots, journalItems, stopping]
  )
}
