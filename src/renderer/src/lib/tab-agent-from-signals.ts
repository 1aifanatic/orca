import type { AgentProcessPresence } from '../../../shared/agent-process-presence'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  resolveLegacyLaunchedAgentExitEvidence,
  resolveLegacyTabAgentFromSignals
} from './legacy-unidentified-agent-presence'

/** Undefined means this host has not published a process identity. */
export function selectAgentPresence(presence?: AgentProcessPresence): TuiAgent | null | undefined {
  if (!presence?.process) {
    return undefined
  }
  return !presence.ended && isTuiAgent(presence.agent) ? presence.agent : null
}

export function resolveTabAgentFromSignals(
  args: Parameters<typeof resolveLegacyTabAgentFromSignals>[0] & {
    agentPresence?: AgentProcessPresence
  }
): TuiAgent | null {
  const owner = selectAgentPresence(args.agentPresence)
  return owner === undefined ? resolveLegacyTabAgentFromSignals(args) : owner
}

export function resolveLaunchedAgentExitEvidence(
  args: Parameters<typeof resolveLegacyLaunchedAgentExitEvidence>[0] & {
    agentPresence?: AgentProcessPresence
  }
): boolean {
  return args.agentPresence?.process
    ? args.agentPresence.ended === true
    : resolveLegacyLaunchedAgentExitEvidence(args)
}
