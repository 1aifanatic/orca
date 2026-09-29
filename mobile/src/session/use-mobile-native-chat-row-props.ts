import { useMemo, useState } from 'react'
import { createNativeChatRowReuse } from '../../../src/shared/native-chat-row-reuse'
import {
  nativeChatSubagentLabel,
  nativeChatSubagentLabels
} from '../../../src/shared/native-chat-subagent-attribution'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { MobileNativeChatTurnRow } from './use-mobile-native-chat-turn-disclosure'

export type MobileNativeChatRowProps = MobileNativeChatTurnRow & {
  subagentLabel: string | undefined
}

// Why: a streamed batch rebuilds the lookups behind these props, and each settled turn's
// status object with them; reused, `renderItem` and settled rows keep their identity.
const createRowPropsReuse = () => createNativeChatRowReuse<MobileNativeChatRowProps>(1)

/** Each list row's turn and subagent props, by row id. */
export function useMobileNativeChatRowProps(
  data: readonly NativeChatMessage[],
  /** The raw transcript, whose rosters name the subagents. */
  messages: readonly NativeChatMessage[],
  resolveTurnRow: (index: number, message: NativeChatMessage) => MobileNativeChatTurnRow
): readonly MobileNativeChatRowProps[] {
  const subagentLabels = useMemo(() => nativeChatSubagentLabels(messages), [messages])
  const [reuseRowProps] = useState(createRowPropsReuse)
  // Why: the view re-renders on every composer keystroke; only row or turn changes need this pass.
  return useMemo(
    () =>
      reuseRowProps(
        data.map((message, index) => ({
          subagentLabel: nativeChatSubagentLabel(subagentLabels, message),
          ...resolveTurnRow(index, message)
        })),
        (index) => data[index]!.id
      ),
    [reuseRowProps, data, subagentLabels, resolveTurnRow]
  )
}
