import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'

/**
 * What one execution-host inspection says about the agent under a PTY's shell: `exited` only when
 * the host read its process table and found no child of the shell (a suspended or backgrounded
 * agent is still a child), `running` when something still runs there, else `unverifiable`.
 */
export type AgentExitInspectionVerdict = 'exited' | 'running' | 'unverifiable'

export function classifyAgentExitInspection(
  inspection: TerminalProcessInspection | null | undefined,
  expectedIncarnationId: string | null
): AgentExitInspectionVerdict {
  if (!inspection || inspection.verdict === 'unverifiable') {
    return 'unverifiable'
  }
  const evidence = inspection.foregroundProcessEvidence
  // Why: another incarnation's answer, or a PTY tombstone, says nothing about this agent.
  if (
    evidence &&
    (evidence.verdict !== 'live' || evidence.ptyIncarnationId !== expectedIncarnationId)
  ) {
    return 'unverifiable'
  }
  if (
    inspection.childProcessEvidence === 'children' ||
    recognizeAgentProcess(evidence?.processName ?? inspection.foregroundProcess) !== null
  ) {
    return 'running'
  }
  return inspection.childProcessEvidence === 'no-children' ? 'exited' : 'unverifiable'
}
