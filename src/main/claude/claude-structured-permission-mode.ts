import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatPermissionModes,
  isAgentChatPermissionMode,
  type AgentChatPermissionMode,
  type AgentSessionPermissionModes
} from '../../shared/agent-chat-permission-mode'
import type { ListedModel } from './claude-structured-model-catalog'

const CLAUDE_SDK_PERMISSION_MODES = {
  ask: 'default',
  'accept-edits': 'acceptEdits',
  auto: 'auto',
  bypass: 'bypassPermissions'
} as const satisfies Record<AgentChatPermissionMode, PermissionMode>

/** The chat's mode as Claude's own `set_permission_mode` / `--permission-mode` value. */
export function claudeSdkPermissionMode(mode: AgentChatPermissionMode): PermissionMode {
  return CLAUDE_SDK_PERMISSION_MODES[mode]
}

/** Starts in the chat's mode without a restore request or a newer bypass-allow flag. */
export function claudeStructuredPermissionOptions(mode: AgentChatPermissionMode): {
  permissionMode?: PermissionMode
  extraArgs?: Record<string, string | null>
} {
  if (mode === 'bypass') {
    return { extraArgs: { 'dangerously-skip-permissions': null } }
  }
  return mode === 'ask' ? {} : { permissionMode: claudeSdkPermissionMode(mode) }
}

/** The chat mode a Claude child runs and the one the chat now wants. */
export type ClaudePermissionModeState = {
  options: ReadonlyMap<string, string>
  /** What the child was launched for; absent was launched without the bypass flag. */
  launchPermissionMode?: AgentChatPermissionMode
}

/** The chat's mode: its own pick, else what its child was launched for. */
export function claudeChatPermissionMode(
  session: ClaudePermissionModeState
): AgentChatPermissionMode {
  const picked = session.options.get(AGENT_CHAT_PERMISSION_MODE_OPTION_ID)
  return isAgentChatPermissionMode(picked) ? picked : (session.launchPermissionMode ?? 'ask')
}

/**
 * The CLI refuses `set_permission_mode bypassPermissions` on a session that was not launched with
 * `--dangerously-skip-permissions` ("Cannot set permission mode to bypassPermissions because the
 * session was not launched with --dangerously-skip-permissions"). Such a pick is kept as the
 * chat's choice and the host starts the next send on a child launched with the flag. Derived from
 * the child and the pick on every read, so nothing latches.
 */
export function claudePermissionModeNeedsRelaunch(session: ClaudePermissionModeState): boolean {
  return claudeChatPermissionMode(session) === 'bypass' && session.launchPermissionMode !== 'bypass'
}

/** What a Claude chat publishes about its mode. Auto is withheld only where the current model's
 *  listing says it cannot run it; otherwise a refusal comes back through the option-failure path. */
export function claudePermissionModesFor(
  session: ClaudePermissionModeState,
  currentModel: Pick<ListedModel, 'supportsAutoMode'> | undefined
): AgentSessionPermissionModes {
  const current = claudeChatPermissionMode(session)
  // A stored auto pick stays listed, so the pill still names what the chat holds.
  const autoReview = currentModel?.supportsAutoMode !== false || current === 'auto'
  const supported = agentChatPermissionModes('claude', { autoReview }) ?? []
  return { current, supported }
}

/**
 * How a pick of `value` reaches a running child: live through `set_permission_mode`, or — for
 * Full access on a child launched without the bypass flag, which the CLI refuses — kept as the
 * chat's choice for the relaunch before the next send. Null for a value Claude has no mode for.
 */
export function claudePermissionModeWrite(
  session: ClaudePermissionModeState,
  value: string
): { kind: 'live'; mode: PermissionMode } | { kind: 'relaunch' } | null {
  if (!isAgentChatPermissionMode(value) || !agentChatPermissionModes('claude')?.includes(value)) {
    return null
  }
  return claudePermissionModeNeedsRelaunch({
    options: new Map([[AGENT_CHAT_PERMISSION_MODE_OPTION_ID, value]]),
    ...(session.launchPermissionMode ? { launchPermissionMode: session.launchPermissionMode } : {})
  })
    ? { kind: 'relaunch' }
    : { kind: 'live', mode: claudeSdkPermissionMode(value) }
}
