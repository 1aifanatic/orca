import {
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ORCA_SCRUB_SAFE_PANE_ENV
} from '../../shared/agent-hook-scrub-safe-env'
import { AGENT_HOOK_RUNTIME_ENV_KEYS } from '../ipc/pty/host-env/spawn-env-keys'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'

export type PiRpcLaunchOptions = {
  /** Binary and paths are resolved by the execution host before building the launch. */
  command: string
  cwd: string
  fullAccess: boolean
  extraArgs?: readonly string[]
  env?: Record<string, string>
  sessionFile?: string
}

const CHILD_ENV_TO_DELETE: readonly string[] = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  ORCA_SCRUB_SAFE_PANE_ENV,
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ...AGENT_HOOK_RUNTIME_ENV_KEYS
]

/** Pi stores its own sessions; an explicit session file is shared with terminal resumes. */
export function buildPiRpcLaunch(options: PiRpcLaunchOptions): ProviderProcessLaunch {
  if (!options.fullAccess) {
    throw new Error('Pi structured chat supports full access only')
  }
  const args = [...(options.extraArgs ?? [])]
  let provider = false
  let model = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const flag = arg.split('=')[0]
    if (flag === '--provider' || flag === '--model' || flag === '-m') {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++index]
      if (!value || value.startsWith('-')) {
        throw new Error(`Pi ${flag} requires a value`)
      }
      if (flag === '--provider') {
        provider = true
      } else {
        model = true
      }
    } else if (
      [
        '--mode',
        '--print',
        '-p',
        '--no-session',
        '--session',
        '-r',
        '--resume',
        '-c',
        '--continue'
      ].includes(flag)
    ) {
      throw new Error(`Pi ${flag} conflicts with the structured chat launch`)
    }
  }
  if (provider && !model) {
    throw new Error('Pi --provider requires --model')
  }
  return {
    command: options.command,
    cwd: options.cwd,
    args: [
      '--mode',
      'rpc',
      ...args,
      ...(options.sessionFile ? ['--session', options.sessionFile] : [])
    ],
    env: options.env,
    envToDelete: CHILD_ENV_TO_DELETE
  }
}
