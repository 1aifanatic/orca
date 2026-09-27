import { AgentDisabledLaunchError } from '../../shared/agent-disabled-launch-refusal'
import type { TuiAgent } from '../../shared/tui-agent'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

/** Unreadable settings disable nothing here; the launch then fails on its own missing store. */
export function isAgentEnabledForRuntime(
  runtime: Pick<OrcaRuntimeService, 'getClientSettings'>,
  agent: TuiAgent
): boolean {
  let disabled: Iterable<unknown> | undefined
  try {
    disabled = runtime.getClientSettings().disabledTuiAgents
  } catch {
    return true
  }
  return isTuiAgentEnabled(agent, disabled)
}

/** Throws `AgentDisabledLaunchError` for an agent the user turned off. */
export function refuseDisabledAgentForRuntime(
  runtime: Pick<OrcaRuntimeService, 'getClientSettings'>,
  agent: TuiAgent
): void {
  if (!isAgentEnabledForRuntime(runtime, agent)) {
    throw new AgentDisabledLaunchError(agent)
  }
}
