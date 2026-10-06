import { useMemo } from 'react'
import { selectNativeChatLiveReasoning } from '../../../../shared/native-chat-reasoning-row'
import { isNativeChatRowInLiveWorkingTurn } from '../../../../shared/native-chat-turn-membership'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  buildNativeChatTranscriptSlots,
  type NativeChatTranscriptSlot,
  type NativeChatTranscriptSlotsInput
} from './native-chat-transcript-slots'

/** The transcript's slots, and the open reasoning block the live activity line discloses instead
 *  of a slot. Decided together, so a row is hidden exactly while the line shows it. */
export function useNativeChatTranscriptSlots({
  lineShowsThinking,
  ...input
}: Omit<NativeChatTranscriptSlotsInput, 'liveReasoningId'> & {
  /** The live line's own render condition and that it reads "Thinking". */
  lineShowsThinking: boolean
}): { slots: NativeChatTranscriptSlot[]; liveReasoning: NativeChatMessage | null } {
  const {
    messages,
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
  } = input
  const liveReasoning = useMemo(
    () =>
      selectNativeChatLiveReasoning(
        messages,
        (index) =>
          isNativeChatRowInLiveWorkingTurn(
            turnKeys[index],
            liveTurnKey,
            isWorking || lifecycleWorking
          ),
        lineShowsThinking
      ),
    [isWorking, lifecycleWorking, lineShowsThinking, liveTurnKey, messages, turnKeys]
  )
  const liveReasoningId = liveReasoning?.id ?? null
  const slots = useMemo(
    () =>
      buildNativeChatTranscriptSlots({
        messages,
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
        liveReasoningId
      }),
    [
      expandedTurnKeys,
      isWorking,
      lifecycleWorking,
      liveReasoningId,
      liveTurnKey,
      messages,
      receipts,
      subagentChoices,
      subagentSections,
      turnDiffs,
      turnKeys,
      turnStatuses
    ]
  )
  return { slots, liveReasoning }
}
