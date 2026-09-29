import {
  agentVerdictDisplayMark,
  type AgentMainAgentVerdictSource
} from '../../../shared/agent-main-agent-verdict'

/** The line an agent row shows in place of its preview once its verdict marks it. Only a user's
 *  Stop reads interrupted; a turn cut off by a crash reads failed, as a failure does. */
export function agentVerdictStatusLine(entry: AgentMainAgentVerdictSource): string | null {
  switch (agentVerdictDisplayMark(entry)) {
    case 'failed':
      return 'Failed'
    case 'interrupted':
      return 'Interrupted by user'
    case 'unconfirmed':
      return 'Couldn’t confirm'
    case null:
      return null
  }
}
