import type { AgentProcessPresence } from '../../../shared/agent-process-presence'
import { selectAgentPresence } from '../../../shared/agent-process-presence'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  resolveLegacyLaunchedAgentExitEvidence,
  resolveLegacyTabAgentFromSignals
} from './legacy-unidentified-agent-presence'

export { selectAgentPresence } from '../../../shared/agent-process-presence'

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
