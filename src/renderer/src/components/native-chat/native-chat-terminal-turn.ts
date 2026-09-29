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
