import {
  agentTurnStoppedByUser,
  agentVerdictDisplayMark,
  type AgentMainAgentVerdictSource
} from '../../../shared/agent-main-agent-verdict'

/** The line an agent row shows in place of its preview once its verdict marks it. Only a stop the
 *  user asked for says so: a turn cut off by a crash reads plainly interrupted. */
export function agentVerdictStatusLine(entry: AgentMainAgentVerdictSource): string | null {
  switch (agentVerdictDisplayMark(entry)) {
    case 'failed':
      return 'Failed'
    case 'interrupted':
      return agentTurnStoppedByUser(entry) ? 'Interrupted by user' : 'Interrupted'
    case 'unconfirmed':
      return 'Couldn’t confirm'
    case null:
      return null
  }
}
