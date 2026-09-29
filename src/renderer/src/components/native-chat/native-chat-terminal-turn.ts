import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  isInterruptedStatusMessage,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'
import type {
  NativeChatSettledTurn,
  NativeChatSettledTurns
} from '../../../../shared/native-chat-turn-status'
import { isNoiseMessage } from '../../../../shared/native-chat-noise'
import type { NativeChatAwaitingInput } from './NativeChatMessageList'
import { shouldShowNativeChatWorking } from './native-chat-working-suppression'

export type NativeChatTerminalTurn = {
  /** The agent is generating: drives Stop-vs-Send and the streaming preview. */
  isWorking: boolean
  /** The turn is running, including while its agent waits on the reader, as a
   *  structured turn runs on behind its prompt card: its clock keeps counting. */
  turnActive: boolean
  awaitingInput: NativeChatAwaitingInput | null
}

/** The turn facts a terminal-backed pane feeds the shared turn-status UI. */
export function resolveNativeChatTerminalTurn(args: {
  isConversation: boolean
  /** Hook 'working', reconciled with the transcript's turn boundaries. */
  working: boolean
  /** Hook 'waiting'/'blocked', reconciled the same way. */
  hookAwaitingInput: boolean
  /** Local Stop suppression. */
  interrupted: boolean
  /** The pane draws the agent's prompt as a card. */
  hasPromptCard: boolean
}): NativeChatTerminalTurn {
  const { isConversation, working, hookAwaitingInput, interrupted, hasPromptCard } = args
  const turnActive = shouldShowNativeChatWorking({
    isConversation,
    working: working || hookAwaitingInput,
    interrupted
  })
  return {
    isWorking: shouldShowNativeChatWorking({ isConversation, working, interrupted }),
    turnActive,
    // A prompt only the terminal shows is the one wait the transcript has to report.
    awaitingInput: hasPromptCard ? 'shown' : turnActive && hookAwaitingInput ? 'unshown' : null
  }
}

/**
 * When the pane's current turn began, by its hook: the start of the unbroken run of mid-turn
 * states under the current prompt. The current state's own start is only the last leg, so a pane
 * mounted after the agent waited on the reader (answered in the terminal) would restart the clock.
 * A changed prompt ends the run: an interrupted wait leaves no hook, so the next turn follows it.
 */
export function nativeChatHookTurnStartedAt(
  entry:
    | Pick<AgentStatusEntry, 'state' | 'prompt' | 'stateStartedAt' | 'stateHistory' | 'mainAgent'>
    | undefined
): number | null {
  if (!entry) {
    return null
  }
  if (entry.state === 'done') {
    return entry.stateStartedAt
  }
  // Child work can hold the row mid-turn from one main-agent turn into the next, so while the main
  // agent runs, its own clock dates the turn. Once it is done, the row's run is the turn's tail.
  const mainAgent = entry.mainAgent?.state === 'done' ? undefined : entry.mainAgent
  let startedAt = mainAgent?.stateStartedAt ?? entry.stateStartedAt
  for (let index = entry.stateHistory.length - 1; index >= 0; index -= 1) {
    const previous = entry.stateHistory[index]!
    const leg = mainAgent ? previous.mainAgent : undefined
    if ((leg?.state ?? previous.state) === 'done' || previous.prompt !== entry.prompt) {
      break
    }
    startedAt = Math.min(startedAt, leg?.stateStartedAt ?? previous.startedAt)
  }
  return startedAt
}

/**
 * Durations of the transcript's finished turns, from its own timestamps (one clock): a turn runs
 * from its prompt to the agent's last timestamped row or its interruption. Other system rows (file
 * mentions, extension notes) can land long after, next to the following prompt. The latest turn is
 * left out, since nothing here says it has ended, and so is a turn missing either end, which keeps
 * what the pane observed.
 */
export function nativeChatTranscriptSettledTurns(
  messages: readonly NativeChatMessage[]
): NativeChatSettledTurns {
  const settled = new Map<string, NativeChatSettledTurn>()
  let turn: { id: string; startedAt: number | null; endedAt: number | null } | null = null
  for (const message of messages) {
    // A harness notice is user-role but draws no row, so it neither starts nor extends a turn.
    if (message.role !== 'user' || isNoiseMessage(message)) {
      const agentRow =
        message.role === 'system' ? isInterruptedStatusMessage(message) : message.role !== 'user'
      if (turn && agentRow && message.timestamp != null) {
        turn.endedAt = Math.max(turn.endedAt ?? message.timestamp, message.timestamp)
      }
      continue
    }
    if (turn?.startedAt != null && turn.endedAt != null) {
      settled.set(turn.id, {
        startedAt: turn.startedAt,
        workedSeconds: Math.max(0, Math.floor((turn.endedAt - turn.startedAt) / 1000))
      })
    }
    turn = { id: message.id, startedAt: message.timestamp, endedAt: null }
  }
  return settled
}
