import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import { isNativeChatEnabled } from '../../../../shared/structured-native-chat-launch-route'
import type { NativeChatLaunchPromptDelivery } from '@/lib/native-chat-launch-prompt-delivery'
import { resolveNativeChatLaunchSessionOptions } from './native-chat-session-option-enrichment'

type NativeChatLaunchSettings = Pick<
  GlobalSettings,
  'experimentalNativeChat' | 'nativeChatSessionOptions'
>

export type InitialNativeChatSessionOptionsArgs = {
  agent: TuiAgent
  promptDelivery?: NativeChatLaunchPromptDelivery
  launchDraftText?: string
  nativeChatTranscriptIsLocalReadable?: boolean
}

export function resolveInitialNativeChatSessionOptions(
  settings: NativeChatLaunchSettings | null | undefined,
  args: InitialNativeChatSessionOptionsArgs
): Record<string, SessionOptionValue> | undefined {
  return isNativeChatEnabled(settings)
    ? resolveNativeChatLaunchSessionOptions(settings?.nativeChatSessionOptions, args.agent)
    : undefined
}
