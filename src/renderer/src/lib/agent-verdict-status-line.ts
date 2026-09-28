import {
  agentVerdictDisplayMark,
  type AgentMainAgentVerdictSource
} from '../../../shared/agent-main-agent-verdict'

/** The line an agent row shows in place of its preview once its verdict marks it. A user's Stop
 *  marks done but still says so; a turn cut off by a crash reads plainly interrupted. */
export function agentVerdictStatusLine(entry: AgentMainAgentVerdictSource): string | null {
  switch (agentVerdictDisplayMark(entry)) {
    case 'failed':
      return 'Failed'
    case 'done':
      return 'Interrupted by user'
    case 'interrupted':
      return 'Interrupted'
    case 'unconfirmed':
      return 'Couldn’t confirm'
    case null:
      return null
  }
}
