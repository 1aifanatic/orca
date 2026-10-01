import { getCodexHookFlagTablePath } from '../../../codex/codex-hook-flag-table'
import { scheduleCodexHookFlagSync } from '../../../codex/codex-hook-flag-sync'
import { ORCA_CODEX_HOOK_FLAGS_ENV } from '../../../../shared/codex-shell-function'
import {
  getCodexCmdHookFlagGateEnvValue,
  ORCA_CODEX_HOOK_ARG_ENV,
  ORCA_CODEX_HOOK_GATE_ENV
} from '../../../codex/codex-cmd-hook-flag-gate'
import type { BuildPtyHostEnvOptions } from './types'

/**
 * Points a native pane's codex function at Orca's flag table, which each launch
 * reads. Set whatever the settings say: the table is empty while Codex hooks
 * are off, and the pointer stays valid across Orca restarts, so a pane the
 * daemon keeps follows every later change. WSL guests run a Linux Codex whose
 * hash this process never asked for, and keep their installed hooks.
 */
export function applyCodexHookSessionFlagEnv(
  baseEnv: Record<string, string>,
  opts: BuildPtyHostEnvOptions
): void {
  // Why always cleared: the cmd macro must see it unset at startup, and only its gate sets it.
  delete baseEnv[ORCA_CODEX_HOOK_ARG_ENV]
  if (opts.isWsl) {
    delete baseEnv[ORCA_CODEX_HOOK_FLAGS_ENV]
    delete baseEnv[ORCA_CODEX_HOOK_GATE_ENV]
    return
  }
  baseEnv[ORCA_CODEX_HOOK_FLAGS_ENV] = getCodexHookFlagTablePath()
  // Why each spawn: serves a request the file watch missed, and a codex installed or updated meanwhile.
  scheduleCodexHookFlagSync()
  if (process.platform === 'win32') {
    baseEnv[ORCA_CODEX_HOOK_GATE_ENV] = getCodexCmdHookFlagGateEnvValue()
  } else {
    delete baseEnv[ORCA_CODEX_HOOK_GATE_ENV]
  }
}
