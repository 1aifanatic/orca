/**
 * The `agent.launch` operations this process is running, by ledger key: a retry under the same id
 * joins the running one across window reloads.
 */

import type { AgentLaunchResult } from '../../../../shared/agent-launch-intent'
import type { OrcaRuntimeService } from '../../orca-runtime'

type AgentLaunchOwner = Pick<OrcaRuntimeService, 'openedAgentSessionRecordStore'>

type ActiveAgentLaunch = {
  fingerprint: string
  promise: Promise<AgentLaunchResult>
}

const activeAgentLaunchesByRuntime = new WeakMap<AgentLaunchOwner, Map<string, ActiveAgentLaunch>>()

export function activeAgentLaunchesFor(runtime: AgentLaunchOwner): Map<string, ActiveAgentLaunch> {
  const existing = activeAgentLaunchesByRuntime.get(runtime)
  if (existing) {
    return existing
  }
  const active = new Map<string, ActiveAgentLaunch>()
  activeAgentLaunchesByRuntime.set(runtime, active)
  return active
}
