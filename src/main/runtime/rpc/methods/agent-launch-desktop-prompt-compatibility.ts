import {
  AGENT_LAUNCH_RUNTIME_CAPABILITIES,
  supportsDesktopNewTabAgentLaunch
} from '../../../../shared/agent-launch-runtime-capability'
import { isDesktopNewTabPrompt } from '../../../../shared/desktop-new-tab-prompt'
import { isDesktopLaunchCaller } from './agent-launch-desktop-caller'
import { agentLaunchOperationCallerKey } from './agent-launch-replay'
import type { AgentLaunchParams } from './agent-launch-schemas'
import type { RpcContext } from '../core'

export function requireDesktopPromptCompatibility(
  params: AgentLaunchParams,
  context: RpcContext
): void {
  if (
    isDesktopNewTabPrompt(params.prompt) &&
    !(
      supportsDesktopNewTabAgentLaunch(AGENT_LAUNCH_RUNTIME_CAPABILITIES) &&
      supportsDesktopNewTabAgentLaunch(context.clientCapabilities) &&
      isDesktopLaunchCaller(agentLaunchOperationCallerKey(context))
    )
  ) {
    throw new Error('agent_launch_desktop_new_tab_unsupported')
  }
}
