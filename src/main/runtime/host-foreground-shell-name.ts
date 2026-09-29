import type { ForegroundAgentJudgement } from '../../shared/foreground-agent-verdict'
import { isShellProcess } from '../../shared/shell-process-detection'
import {
  isClientOnlyUnverifiableInspection,
  type TerminalProcessInspection
} from '../../shared/terminal-process-inspection'

/**
 * A loaded host misses the fenced evidence's capture budget or age gate, which leaves an exit
 * undecided forever. The same reply's live foreground name still proves a shell, but only when the
 * reply names this PTY incarnation; any other name (e.g. native Claude's `2.1.258`) stays undecided.
 */
export function judgeWithForegroundShellName(
  judgement: ForegroundAgentJudgement,
  inspection: TerminalProcessInspection | string | null | undefined,
  expectedPtyId: string,
  incarnationId: string | null
): ForegroundAgentJudgement {
  if (
    judgement.verdict !== 'unverifiable' ||
    judgement.blindness ||
    !incarnationId ||
    !inspection ||
    typeof inspection === 'string' ||
    isClientOnlyUnverifiableInspection(inspection)
  ) {
    return judgement
  }
  const evidence = inspection.foregroundProcessEvidence
  const name = inspection.foregroundProcess
  if (
    evidence?.ptyId !== expectedPtyId ||
    evidence.ptyIncarnationId !== incarnationId ||
    !name ||
    !isShellProcess(name)
  ) {
    return judgement
  }
  return { verdict: 'exited', processName: name, canCertifyExit: true }
}
