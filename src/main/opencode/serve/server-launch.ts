import { restoreOrStripOverlayEnv } from '../../../shared/agent-overlay-env'
import {
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ORCA_SCRUB_SAFE_PANE_ENV
} from '../../../shared/agent-hook-scrub-safe-env'
import { AGENT_HOOK_RUNTIME_ENV_KEYS } from '../../ipc/pty/host-env/spawn-env-keys'
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'

const PANE_ENV = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  ORCA_SCRUB_SAFE_PANE_ENV,
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ...AGENT_HOOK_RUNTIME_ENV_KEYS,
  'ORCA_OPENCODE_AGENT',
  'ORCA_OPENCODE_CONFIG_DIR',
  'ORCA_OPENCODE_SOURCE_CONFIG_DIR'
] as const

export type OpenCodeServerLaunchInput = {
  /** Resolved on the execution host, including its Windows command-shim handling. */
  command: string
  cwd: string
  environment: Record<string, string>
  port: number
  password: string
}

export function openCodeServerLaunch(input: OpenCodeServerLaunchInput): ProviderProcessLaunch {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new RangeError('OpenCode server requires an explicit TCP port')
  }
  if (!input.cwd || !input.command || !input.password) {
    throw new Error('OpenCode server requires a command, workspace and password')
  }
  const env = { ...input.environment }
  restoreOrStripOverlayEnv(
    env,
    {
      primary: 'OPENCODE_CONFIG_DIR',
      overlay: 'ORCA_OPENCODE_CONFIG_DIR',
      source: 'ORCA_OPENCODE_SOURCE_CONFIG_DIR',
      preserveExplicitPrimary: true
    },
    {}
  )
  for (const key of PANE_ENV) {
    delete env[key]
  }
  // Each major reads its own password variable; the private server uses the same credential.
  env.OPENCODE_SERVER_PASSWORD = input.password
  env.OPENCODE_PASSWORD = input.password
  env.OPENCODE_SERVER_USERNAME = 'opencode'
  return {
    command: input.command,
    args: ['serve', '--hostname=127.0.0.1', `--port=${input.port}`],
    cwd: input.cwd,
    env,
    // Overlay removal must also win over the supervisor's inherited environment.
    envToDelete: [...PANE_ENV, ...(env.OPENCODE_CONFIG_DIR ? [] : ['OPENCODE_CONFIG_DIR'])]
  }
}
