import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../shared/command-token-scanner'
import type { TuiAgent } from '../../shared/tui-agent'
import { getManagedDataAccountService } from './service'
import {
  captureManagedDataAccountOriginalEnvironment,
  MANAGED_DATA_ACCOUNT_BASELINE_ENV_KEYS,
  restoreManagedDataAccountEnvironment
} from '../../shared/managed-data-account-environment'

export function applyManagedDataAccountEnvironment(
  environment: Record<string, string>,
  options: { launchAgent?: TuiAgent; launchCommand?: string; isWsl?: boolean }
): void {
  restoreManagedDataAccountEnvironment(environment)
  const inherited = { ...process.env }
  restoreManagedDataAccountEnvironment(inherited)
  for (const key of MANAGED_DATA_ACCOUNT_BASELINE_ENV_KEYS) {
    const value = inherited[key]
    if (environment[key] === undefined && value !== undefined) {
      environment[key] = value
    }
  }
  if (options.isWsl) {
    return
  }
  const agent =
    options.launchAgent ??
    getCommandTokenPathBasename(getFirstCommandToken(options.launchCommand ?? '')).replace(
      /\.(?:exe|cmd|sh)$/i,
      ''
    )
  const provider =
    agent === 'opencode' || agent === 'opencode2' ? 'opencode' : agent === 'devin' ? 'devin' : null
  if (!provider) {
    return
  }
  const selected = getManagedDataAccountService().launchEnvironment(provider)
  if (!selected.XDG_DATA_HOME) {
    return
  }
  captureManagedDataAccountOriginalEnvironment(environment)
  Object.assign(environment, selected)
  environment.ORCA_DATA_ACCOUNT_DATA_HOME = selected.XDG_DATA_HOME
  environment.ORCA_DATA_ACCOUNT_STATE_HOME = selected.XDG_STATE_HOME
  environment.ORCA_DATA_ACCOUNT_PROVIDER = provider
  if (provider === 'opencode') {
    // Database overrides and inline auth would bypass this profile's credentials.
    environment.OPENCODE_AUTH_CONTENT = ''
    environment.OPENCODE_DB = 'opencode.db'
  }
}
