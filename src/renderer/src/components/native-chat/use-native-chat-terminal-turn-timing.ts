import { useMemo } from 'react'
import { useAppStore } from '../../store'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatSettledTurns } from '../../../../shared/native-chat-turn-status'
import {
  nativeChatHookTurnStartedAt,
  nativeChatTranscriptSettledTurns
} from './native-chat-terminal-turn'

/** The terminal-backed pane's turn timing for the message list: when its running turn began, by
 *  the hook, and the transcript's finished-turn durations. Both survive a remount of the pane. */
export function useNativeChatTerminalTurnTiming(
  paneKey: string,
  messages: readonly NativeChatMessage[],
  turnActive: boolean
): { workingStartedAt: number | null; settledTurns: NativeChatSettledTurns } {
  const turnStartedAt = useAppStore((s) =>
    nativeChatHookTurnStartedAt(s.agentStatusByPaneKey[paneKey])
  )
  const settledTurns = useMemo(() => nativeChatTranscriptSettledTurns(messages), [messages])
  return { workingStartedAt: turnActive ? turnStartedAt : null, settledTurns }
}
