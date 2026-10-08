// The blocked-prompt verdict shared by `agentWait` and the agent-prompt send gate.
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'

/**
 * Judges the line-tail arbiter's verdict against the rendered screen, as the tui-idle poll does.
 * `screenReason` undefined means the runtime holds no current whole-screen model, so the tail
 * verdict stands: missing evidence neither clears nor blocks.
 */
export function judgeBlockedAgainstLiveScreen(input: {
  tailVerdict: RuntimeTerminalWaitBlockedReason | null
  screenReason: RuntimeTerminalWaitBlockedReason | null | undefined
  agentWorking: boolean
}): RuntimeTerminalWaitBlockedReason | null {
  const { tailVerdict, screenReason } = input
  if (screenReason === undefined) {
    return tailVerdict
  }
  // Why the screen vetoes the tail: an idle pane prints nothing, so dialog text and its
  // output-time stamp outlive a dialog the screen no longer shows (STA-9039).
  if (screenReason === null) {
    return null
  }
  // Why working gates only the screen lane: a mid-turn agent's output can quote dialog wording,
  // and a dialog the tail lost (Claude's workspace trust) is a start-up one, before any turn.
  return tailVerdict !== null || !input.agentWorking ? screenReason : null
}
