import { AGENT_TUI_CLEAR_MAX_LINES, countAgentTuiInputLines } from './agent-tui-input-clear'
import {
  isNativeChatSupportedAgent,
  nativeChatRequiresLocalTranscript
} from './native-chat-agent-support'
import { agentTabsDefaultToNativeChat } from './structured-native-chat-launch-route'
import type { TerminalTabViewMode } from './terminal-tab-view-mode'

export type NativeChatLaunchPromptDelivery = 'auto-submit' | 'draft' | 'submit-after-ready'

/**
 * Single source of truth for whether unsent launch context can be mirrored from
 * the agent's TUI input into the native-chat composer.
 *
 * Both the seeding path (`seedNativeChatLaunchDraftForAgentTab`) and the
 * starting-view decision gate on this one predicate, so a draft launch can never
 * open in chat with a composer that chat then refuses to fill.
 *
 * CR/LF drafts are safe within the bounded TUI-clear budget. Unicode line
 * separators and drafts beyond that budget remain terminal-only.
 */
export function canMirrorLaunchDraftToNativeChat(text: string): boolean {
  return (
    text.trim().length > 0 &&
    !/[\u2028\u2029]/.test(text) &&
    countAgentTuiInputLines(text) <= AGENT_TUI_CLEAR_MAX_LINES
  )
}

export type AgentTabStartingViewInput = {
  /** The launching device's choice. Absent means the deciding host's own default applies. */
  request?: TerminalTabViewMode
  /** The deciding host's (or the local device's) Chat UI settings. */
  settings:
    | { experimentalNativeChat?: boolean; openAgentTabsInChatByDefault?: boolean }
    | null
    | undefined
  /** The launched agent; none means a plain shell, which gets no starting view. */
  agent?: string | null
  promptDelivery?: NativeChatLaunchPromptDelivery
  /** The unsent launch context, when `promptDelivery` is `'draft'`. */
  launchDraftText?: string
  nativeChatTranscriptIsLocalReadable?: boolean
}

/** Whether chat can show this launch at all; a choice of chat it fails starts in terminal. */
function chatCanShowLaunch(input: AgentTabStartingViewInput): boolean {
  if (!isNativeChatSupportedAgent(input.agent)) {
    return false
  }
  if (
    nativeChatRequiresLocalTranscript(input.agent) &&
    input.nativeChatTranscriptIsLocalReadable !== true
  ) {
    return false
  }
  return (
    input.promptDelivery !== 'draft' ||
    canMirrorLaunchDraftToNativeChat(input.launchDraftText ?? '')
  )
}

/**
 * The view a new agent tab starts in, decided once at creation: the launcher's choice, else the
 * deciding host's default, gated by what chat can show. Explicit 'terminal' is returned for every
 * recognized agent launch, because an absent view means "an old unswitched tab" to every reader.
 * Idempotent: finalizing an already-final value returns it unchanged.
 */
export function finalizeAgentTabStartingView(
  input: AgentTabStartingViewInput
): TerminalTabViewMode | undefined {
  if (!input.agent) {
    return undefined
  }
  const wantsChat = input.request
    ? input.request === 'chat'
    : agentTabsDefaultToNativeChat(input.settings)
  return wantsChat && chatCanShowLaunch(input) ? 'chat' : 'terminal'
}
