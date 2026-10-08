import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isNativeChatEnabled } from '../../../shared/structured-native-chat-launch-route'
import type { Tab } from '../../../shared/tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { canMirrorLaunchDraftToNativeChat } from '@/lib/native-chat-launch-draft-mirrorability'
import type { NativeChatLaunchPromptDelivery } from '@/lib/native-chat-launch-prompt-delivery'
import {
  isNativeChatSupportedAgent,
  nativeChatRequiresLocalTranscript
} from '@/lib/native-chat-supported-agent'

/**
 * Decide the initial `viewMode` for a newly launched agent tab.
 *
 * Returns `'chat'` only when the setting is explicitly on and the launched
 * agent has a native-chat renderer. A draft launch opens in chat only when its
 * unsent context can be mirrored into the composer — gated on the same
 * predicate as seeding so the view never opens empty beside a filled TUI input.
 */
export function decideInitialAgentTabViewMode(args: {
  experimentalNativeChat?: boolean
  agent?: TuiAgent | null
  promptDelivery?: NativeChatLaunchPromptDelivery
  /** The unsent launch context, when `promptDelivery` is `'draft'`. */
  launchDraftText?: string
  nativeChatTranscriptIsLocalReadable?: boolean
}): Tab['viewMode'] {
  if (!isNativeChatEnabled(args)) {
    return undefined
  }
  if (!isNativeChatSupportedAgent(args.agent)) {
    return undefined
  }
  if (
    nativeChatRequiresLocalTranscript(args.agent) &&
    args.nativeChatTranscriptIsLocalReadable !== true
  ) {
    return undefined
  }
  if (
    args.promptDelivery === 'draft' &&
    !canMirrorLaunchDraftToNativeChat(args.launchDraftText ?? '')
  ) {
    return undefined
  }
  return 'chat'
}

export function initialAgentTabViewModeProps(
  settings: Pick<GlobalSettings, 'experimentalNativeChat'> | null | undefined,
  options: {
    agent?: TuiAgent | null
    promptDelivery?: NativeChatLaunchPromptDelivery
    launchDraftText?: string
    nativeChatTranscriptIsLocalReadable?: boolean
  } = {}
): { viewMode?: Tab['viewMode'] } {
  const viewMode = decideInitialAgentTabViewMode({
    experimentalNativeChat: settings?.experimentalNativeChat,
    agent: options.agent,
    promptDelivery: options.promptDelivery,
    launchDraftText: options.launchDraftText,
    nativeChatTranscriptIsLocalReadable: options.nativeChatTranscriptIsLocalReadable
  })
  return viewMode ? { viewMode } : {}
}
