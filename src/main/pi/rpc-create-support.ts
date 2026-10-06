import type { GlobalSettings } from '../../shared/global-settings-types'
import { nativeChatShellEnvironmentPolicy } from '../../shared/native-chat-shell-environment'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import { createStructuredAgentEnvironmentResolvers } from '../runtime/structured-agent-shell-environment'
import { probePiRpcVersion, resolvePiRpcCommand } from './rpc-version'

export async function supportsPiRpcLaunch(input: {
  settings: Pick<
    GlobalSettings,
    'agentDefaultEnv' | 'nativeChatInheritShellEnvironment' | 'nativeChatShellEnvironmentVariables'
  >
  cwd: string
}): Promise<boolean> {
  const environment = createStructuredAgentEnvironmentResolvers({
    resolveShellEnvironmentPolicy: () => nativeChatShellEnvironmentPolicy(input.settings)
  })
  const env = {
    ...(await environment.resolveBaseEnvironment()),
    ...resolveTuiAgentLaunchEnv('pi', input.settings.agentDefaultEnv)
  }
  return probePiRpcVersion({ program: resolvePiRpcCommand(env), cwd: input.cwd, env })
}
