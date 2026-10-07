import type { AgentPermissionMode } from './tui-agent-permissions'

/**
 * How much a structured chat may do without asking, chosen per chat. A superset of the stored
 * Agent Permissions setting, so the setting can widen to this type with no translation layer.
 */
export type AgentChatPermissionMode = AgentPermissionMode | 'accept-edits' | 'auto'

/** Picker order: least to most access. */
export const AGENT_CHAT_PERMISSION_MODES = [
  'ask',
  'accept-edits',
  'auto',
  'bypass'
] as const satisfies readonly AgentChatPermissionMode[]

/** The session option a chat's mode is written and persisted under. */
export const AGENT_CHAT_PERMISSION_MODE_OPTION_ID = 'permissionMode'

export function isAgentChatPermissionMode(value: unknown): value is AgentChatPermissionMode {
  return AGENT_CHAT_PERMISSION_MODES.some((mode) => mode === value)
}

/** Whether this agent's runtime can route approvals to its own reviewer; unknown counts as yes
 *  until a running child says otherwise. */
export type AgentChatPermissionModeSupport = { autoReview?: boolean }

/**
 * The modes a structured chat of `agent` offers, in picker order; null for an agent with no
 * picker. Codex has no edits-only mode; Approve for me needs Claude auto mode or Codex auto-review.
 */
export function agentChatPermissionModes(
  agent: string,
  support: AgentChatPermissionModeSupport = {}
): readonly AgentChatPermissionMode[] | null {
  const autoReview = support.autoReview !== false
  if (agent === 'claude') {
    return autoReview ? AGENT_CHAT_PERMISSION_MODES : ['ask', 'accept-edits', 'bypass']
  }
  if (agent === 'codex') {
    return autoReview ? ['ask', 'auto', 'bypass'] : ['ask', 'bypass']
  }
  return null
}

export function agentChatPermissionModeSupported(
  agent: string,
  value: unknown,
  support?: AgentChatPermissionModeSupport
): value is AgentChatPermissionMode {
  return (
    isAgentChatPermissionMode(value) &&
    Boolean(agentChatPermissionModes(agent, support)?.includes(value))
  )
}

/** A chat that never chose starts where the Agent Permissions setting points: ask → Ask for
 *  approval, bypass → Full access. Identity today; the setting is a subset of the chat's modes. */
export function agentChatPermissionModeFromSetting(
  setting: AgentPermissionMode
): AgentChatPermissionMode {
  return setting
}

/** The chat's own stored choice, when its record holds a valid one for this agent. */
export function storedAgentChatPermissionMode(
  agent: string,
  options: Readonly<Record<string, string>> | null | undefined
): AgentChatPermissionMode | null {
  const stored = options?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID]
  return agentChatPermissionModeSupported(agent, stored) ? stored : null
}

/** The mode a chat's child launches in: its own stored choice outranks the setting, so a resume
 *  keeps what the chat picked. With no setting wired, it asks. */
export function agentChatLaunchPermissionMode(
  agent: string,
  options: Readonly<Record<string, string>> | null | undefined,
  setting: AgentPermissionMode | undefined
): AgentChatPermissionMode {
  return (
    storedAgentChatPermissionMode(agent, options) ??
    agentChatPermissionModeFromSetting(setting ?? 'ask')
  )
}

/** What a host publishes about a chat's mode; absent from a host that predates the picker. */
export type AgentSessionPermissionModes = {
  /** The mode the chat's next turn runs under. */
  current: AgentChatPermissionMode
  supported: readonly AgentChatPermissionMode[]
}

/** A host's report read defensively: unknown modes from a newer host are dropped, and a current
 *  mode this build cannot name hides the picker rather than guessing. */
export function parseAgentSessionPermissionModes(
  value: unknown
): AgentSessionPermissionModes | null {
  if (!value || typeof value !== 'object' || !('current' in value) || !('supported' in value)) {
    return null
  }
  const { current, supported: listed } = value
  const supported = Array.isArray(listed) ? listed.filter(isAgentChatPermissionMode) : []
  return isAgentChatPermissionMode(current) && supported.includes(current)
    ? { current, supported }
    : null
}

/**
 * A pick, held pick or launch seed applied to what the picker shows. Before the host has reported
 * anything, a seed naming a mode is that host saying it offers the picker, so the agent's own
 * list stands in until a report replaces it. A value outside the list changes nothing.
 */
export function commitAgentSessionPermissionMode(
  permission: AgentSessionPermissionModes | null,
  agent: string,
  value: string
): AgentSessionPermissionModes | null {
  if (!isAgentChatPermissionMode(value)) {
    return permission
  }
  if (permission) {
    return permission.supported.includes(value) ? { ...permission, current: value } : permission
  }
  const supported = agentChatPermissionModes(agent)
  return supported?.includes(value) ? { current: value, supported } : null
}
