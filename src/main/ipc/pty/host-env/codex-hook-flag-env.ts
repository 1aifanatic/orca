import { getCodexHookSessionFlags } from '../../../codex/codex-hook-session-trust'
import {
  ORCA_CODEX_HOOK_CONFIG_ENV,
  ORCA_CODEX_HOOK_VERSION_ENV
} from '../../../../shared/codex-shell-function'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import {
  getCodexCmdHookFlagGateEnvValue,
  ORCA_CODEX_HOOK_ARG_ENV,
  ORCA_CODEX_HOOK_GATE_ENV
} from '../../../codex/codex-cmd-hook-flag-gate'
import type { BuildPtyHostEnvOptions } from './types'

/**
 * The status hook a typed `codex` carries as a session flag. Native panes only:
 * WSL guests run a Linux Codex whose hash this process never asked for, and keep
 * their installed hooks. Cleared otherwise so an inherited value from an
 * enclosing Orca never reaches this pane.
 */
export function applyCodexHookSessionFlagEnv(
  baseEnv: Record<string, string>,
  opts: BuildPtyHostEnvOptions
): void {
  const flags =
    !opts.isWsl &&
    opts.agentStatusHooksEnabled &&
    isTuiAgentEnabled('codex', opts.disabledTuiAgents)
      ? getCodexHookSessionFlags()
      : null
  // Why always cleared: the cmd macro must see it unset at startup, and only its gate sets it.
  delete baseEnv[ORCA_CODEX_HOOK_ARG_ENV]
  if (flags) {
    baseEnv[ORCA_CODEX_HOOK_CONFIG_ENV] = flags.flag
    baseEnv[ORCA_CODEX_HOOK_VERSION_ENV] = flags.codexVersion
  } else {
    delete baseEnv[ORCA_CODEX_HOOK_CONFIG_ENV]
    delete baseEnv[ORCA_CODEX_HOOK_VERSION_ENV]
  }
  if (flags && process.platform === 'win32') {
    baseEnv[ORCA_CODEX_HOOK_GATE_ENV] = getCodexCmdHookFlagGateEnvValue()
  } else {
    delete baseEnv[ORCA_CODEX_HOOK_GATE_ENV]
  }
}
