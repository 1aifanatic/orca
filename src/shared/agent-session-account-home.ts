/** Durable account binding: existing single-directory records or OpenCode's data context. */

import type { AgentSessionStoredAgent } from './agent-session-stored-agent'
import { isRuntimePathAbsolute } from './cross-platform-path'

/** Account root pinned at launch by the account selector, so a resume cannot drift to another login. */
export type LegacyAgentSessionAccountHome = {
  /** Environment variable naming the agent's config directory. */
  variable: string
  /** Host-resolved absolute path in the execution host's own path syntax. */
  path: string
}

export type OpenCodeAccountLocator =
  | { kind: 'managed'; managedProfileId: string }
  | {
      kind: 'unmanaged'
      dataHome: string
      stateHome: string
      databaseSelection: { kind: 'default' } | { kind: 'override'; value: string }
    }

export type OpenCodeAgentSessionAccountHome = {
  kind: 'opencode'
  locator: OpenCodeAccountLocator
}

export type AgentSessionAccountHome =
  | LegacyAgentSessionAccountHome
  | OpenCodeAgentSessionAccountHome

export function isLegacyAgentSessionAccountHome(
  home: AgentSessionAccountHome
): home is LegacyAgentSessionAccountHome {
  return !('kind' in home)
}

export function requireLegacyAgentSessionAccountHome(
  home: AgentSessionAccountHome
): LegacyAgentSessionAccountHome {
  if (!isLegacyAgentSessionAccountHome(home)) {
    throw new Error('Expected a single-directory agent account binding.')
  }
  return home
}

export function agentSessionAccountHomesEqual(
  left: AgentSessionAccountHome,
  right: AgentSessionAccountHome
): boolean {
  if (isLegacyAgentSessionAccountHome(left)) {
    return (
      isLegacyAgentSessionAccountHome(right) &&
      left.variable === right.variable &&
      left.path === right.path
    )
  }
  if (isLegacyAgentSessionAccountHome(right) || left.locator.kind !== right.locator.kind) {
    return false
  }
  if (left.locator.kind === 'managed') {
    return (
      right.locator.kind === 'managed' &&
      left.locator.managedProfileId === right.locator.managedProfileId
    )
  }
  return (
    right.locator.kind === 'unmanaged' &&
    left.locator.dataHome === right.locator.dataHome &&
    left.locator.stateHome === right.locator.stateHome &&
    left.locator.databaseSelection.kind === right.locator.databaseSelection.kind &&
    (left.locator.databaseSelection.kind === 'default' ||
      (right.locator.databaseSelection.kind === 'override' &&
        left.locator.databaseSelection.value === right.locator.databaseSelection.value))
  )
}

/** The account home of `agent` at `path`. */
export function agentSessionAccountHome(
  agent: Pick<AgentSessionStoredAgent, 'accountHomeVariable'>,
  path: string
): LegacyAgentSessionAccountHome {
  return { variable: agent.accountHomeVariable, path }
}

function isBoundedAccountString(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !value.includes('\u0000')
  )
}

function isAbsoluteAccountPath(value: unknown): value is string {
  return isBoundedAccountString(value, 4096) && isRuntimePathAbsolute(value, 'windows')
}

const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Shape only: whether the variable is the one the record's agent pins is a launch-time question
 *  (`agentDrivesSession`), so an agent that renames its variable never hides its chats. */
export function isAgentSessionAccountHome(value: unknown): value is AgentSessionAccountHome {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  if (!('kind' in value)) {
    return (
      'variable' in value &&
      typeof value.variable === 'string' &&
      ENVIRONMENT_VARIABLE_NAME.test(value.variable) &&
      'path' in value &&
      isBoundedAccountString(value.path, 4096)
    )
  }
  if (
    value.kind !== 'opencode' ||
    !('locator' in value) ||
    typeof value.locator !== 'object' ||
    value.locator === null ||
    Array.isArray(value.locator)
  ) {
    return false
  }
  const locator = value.locator
  if (locator.kind === 'managed') {
    return (
      'managedProfileId' in locator &&
      typeof locator.managedProfileId === 'string' &&
      PROFILE_ID.test(locator.managedProfileId) &&
      Object.keys(locator).length === 2 &&
      Object.keys(value).length === 2
    )
  }
  if (
    locator.kind !== 'unmanaged' ||
    !('dataHome' in locator) ||
    !isAbsoluteAccountPath(locator.dataHome) ||
    !('stateHome' in locator) ||
    !isAbsoluteAccountPath(locator.stateHome) ||
    !('databaseSelection' in locator) ||
    typeof locator.databaseSelection !== 'object' ||
    locator.databaseSelection === null ||
    Array.isArray(locator.databaseSelection)
  ) {
    return false
  }
  const databaseSelection = locator.databaseSelection
  return (
    ((databaseSelection.kind === 'default' && Object.keys(databaseSelection).length === 1) ||
      (databaseSelection.kind === 'override' &&
        'value' in databaseSelection &&
        isBoundedAccountString(databaseSelection.value, 4096) &&
        Object.keys(databaseSelection).length === 2)) &&
    Object.keys(locator).length === 4 &&
    Object.keys(value).length === 2
  )
}
