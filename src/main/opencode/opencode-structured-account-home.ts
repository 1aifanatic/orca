import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  isLegacyAgentSessionAccountHome,
  type OpenCodeAgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import {
  getManagedDataAccountService,
  type ManagedDataAccountService
} from '../managed-data-accounts/service'
import type { AcpAccountBinding } from '../acp/acp-account-binding'

type AccountReader = Pick<
  ManagedDataAccountService,
  'list' | 'restoreOriginalEnvironment' | 'environmentForAccount'
>

function restoredEnvironment(
  environment: NodeJS.ProcessEnv,
  managedAccounts: Pick<AccountReader, 'restoreOriginalEnvironment'>
): Record<string, string | undefined> {
  const copy = { ...environment }
  managedAccounts.restoreOriginalEnvironment(copy)
  delete copy.ORCA_DATA_ACCOUNT_PROVIDER
  delete copy.ORCA_DATA_ACCOUNT_DATA_HOME
  delete copy.ORCA_DATA_ACCOUNT_STATE_HOME
  delete copy.ORCA_DATA_ACCOUNT_ORIGINAL_ENV
  return copy
}

function definedEnvironment(
  environment: Record<string, string | undefined>
): Record<string, string> {
  const defined: Record<string, string> = {}
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) {
      defined[key] = value
    }
  }
  return defined
}

/** Resolve the current selection on the execution host when creating a chat. */
export function resolveStructuredOpenCodeAccountHome(input: {
  launchEnv: NodeJS.ProcessEnv
  baseEnvironment?: NodeJS.ProcessEnv
  managedAccounts: AccountReader
  homeDirectory?: string
}): OpenCodeAgentSessionAccountHome {
  const selected = input.managedAccounts.list('opencode').activeAccountId
  if (selected) {
    input.managedAccounts.environmentForAccount('opencode', selected)
    return { kind: 'opencode', locator: { kind: 'managed', managedProfileId: selected } }
  }
  const environment = {
    ...restoredEnvironment(input.baseEnvironment ?? {}, input.managedAccounts),
    ...restoredEnvironment(input.launchEnv, input.managedAccounts)
  }
  if (environment.OPENCODE_AUTH_CONTENT) {
    throw new Error('OpenCode inline authentication cannot be pinned to a structured chat.')
  }
  for (const key of ['XDG_DATA_HOME', 'XDG_STATE_HOME'] as const) {
    const value = environment[key]?.trim()
    if (value && !isAbsolute(value)) {
      throw new Error(`${key} must be an absolute path for structured OpenCode.`)
    }
  }
  const configuredHome =
    process.platform === 'win32'
      ? environment.USERPROFILE ||
        (environment.HOMEDRIVE && environment.HOMEPATH
          ? `${environment.HOMEDRIVE}${environment.HOMEPATH}`
          : undefined)
      : environment.HOME
  if (configuredHome && !isAbsolute(configuredHome)) {
    throw new Error('OpenCode home directory must be an absolute path.')
  }
  const home = input.homeDirectory ?? configuredHome ?? homedir()
  const dataHome = environment.XDG_DATA_HOME?.trim() || join(home, '.local', 'share')
  const stateHome = environment.XDG_STATE_HOME?.trim() || join(home, '.local', 'state')
  const database = environment.OPENCODE_DB?.trim()
  return {
    kind: 'opencode',
    locator: {
      kind: 'unmanaged',
      dataHome,
      stateHome,
      databaseSelection: database ? { kind: 'override', value: database } : { kind: 'default' }
    }
  }
}

/** Resolve a saved binding against the current host, then apply it after inherited overlays. */
export function environmentForStructuredOpenCodeAccountHome(
  binding: OpenCodeAgentSessionAccountHome,
  input: {
    managedAccounts: Pick<AccountReader, 'environmentForAccount' | 'restoreOriginalEnvironment'>
    baseEnvironment: Record<string, string>
  }
): Record<string, string> {
  const environment = restoredEnvironment(input.baseEnvironment, input.managedAccounts)
  delete environment.XDG_DATA_HOME
  delete environment.XDG_STATE_HOME
  delete environment.OPENCODE_DB
  delete environment.OPENCODE_AUTH_CONTENT
  const locator = binding.locator
  if (locator.kind === 'managed') {
    return {
      ...definedEnvironment(environment),
      ...input.managedAccounts.environmentForAccount('opencode', locator.managedProfileId)
    }
  }
  return {
    ...definedEnvironment(environment),
    XDG_DATA_HOME: locator.dataHome,
    XDG_STATE_HOME: locator.stateHome,
    ...(locator.databaseSelection.kind === 'override'
      ? { OPENCODE_DB: locator.databaseSelection.value }
      : {})
  }
}

/** OpenCode's account over ACP: a managed profile or the data and state directories it reads. */
export function openCodeAcpAccountBinding(
  managedAccounts: () => AccountReader = getManagedDataAccountService
): AcpAccountBinding {
  return {
    pin: { accountLocatorKind: 'opencode' },
    resolve: async ({ launchEnv, baseEnvironment }) =>
      resolveStructuredOpenCodeAccountHome({
        launchEnv,
        baseEnvironment: await baseEnvironment(),
        managedAccounts: managedAccounts()
      }),
    environment: (home, env) => {
      if (isLegacyAgentSessionAccountHome(home)) {
        throw new Error('OpenCode chat requires a pinned data account')
      }
      return environmentForStructuredOpenCodeAccountHome(home, {
        managedAccounts: managedAccounts(),
        baseEnvironment: env
      })
    }
  }
}
