import type { GlobalSettings } from './global-settings-types'
import type { TuiAgent } from './tui-agent'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatLaunchPermissionMode,
  agentChatPermissionModes
} from './agent-chat-permission-mode'
import {
  narrowStructuredLaunchSeedOptions,
  resolveStructuredLaunchSeedOptions
} from './native-chat-session-option-defaults'

/** Reviewer intent is retained for the execution host to confirm before a turn. */
export function normalizeStructuredChatLaunchOptions(
  agent: string,
  options: Readonly<Record<string, string>>
): Record<string, string> {
  const seeded = narrowStructuredLaunchSeedOptions(options) ?? {}
  return agentChatPermissionModes(agent)
    ? {
        ...seeded,
        [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: agentChatLaunchPermissionMode(agent, options, 'ask')
      }
    : seeded
}

/** The client resolves once, then its draft and create share the same encoded choices. */
export function resolveStructuredChatLaunchOptions(
  settings:
    | Partial<Pick<GlobalSettings, 'nativeChatSessionOptions' | 'nativeChatPermissionMode'>>
    | null
    | undefined,
  agent: TuiAgent
): Record<string, string> {
  return normalizeStructuredChatLaunchOptions(agent, {
    ...resolveStructuredLaunchSeedOptions(settings?.nativeChatSessionOptions, agent),
    [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: settings?.nativeChatPermissionMode ?? 'bypass'
  })
}

/** Changing models retires picks made under the previous model, as the composer does. */
export function mergeStructuredChatLaunchOptions(
  seed: Readonly<Record<string, string>>,
  held: Readonly<Record<string, string>>
): Record<string, string> {
  const { model, effort: _effort, fastMode: _fastMode, ...chatOptions } = seed
  return held.model !== undefined && held.model !== model
    ? { ...chatOptions, ...held }
    : { ...seed, ...held }
}
