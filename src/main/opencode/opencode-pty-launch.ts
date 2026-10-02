import { addWslEnvKeys } from '../../shared/wsl-env'
import type { TuiAgent } from '../../shared/tui-agent'
import { probeOpenCodeLaunchCapabilities } from './opencode-launch-capabilities'

export async function prepareOpenCodePtyLaunch(options: {
  command: string | undefined
  agent?: TuiAgent
  env: Record<string, string> | undefined
  cwd?: string
  connectionId?: string | null
  isFreshLaunch: boolean
  wsl?: { distro?: string }
}): Promise<Record<string, string> | undefined> {
  const env = options.env ? { ...options.env } : undefined
  if (env) {
    delete env.ORCA_OPENCODE_PLUGIN_API
  }
  if (options.connectionId || !options.isFreshLaunch) {
    return env
  }
  const capabilities = await probeOpenCodeLaunchCapabilities({
    ...options,
    env: { ...process.env, ...env }
  })
  if (!capabilities || capabilities.pluginApi === 'unknown') {
    return env
  }
  const launchEnv = { ...env, ORCA_OPENCODE_PLUGIN_API: capabilities.pluginApi }
  if (options.wsl) {
    addWslEnvKeys(launchEnv, ['ORCA_OPENCODE_PLUGIN_API'])
  }
  return launchEnv
}
