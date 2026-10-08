// The blocked-prompt verdict shared by `agentWait`, the agent-status probe, and the send gate.
import type { AgentStatus } from '../../shared/agent-detection'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import { detectExplicitIdleStatusFromTitle } from './terminal-wait-detection'

/** What the pane's current whole-screen model shows. */
export type LiveScreenBlockedEvidence = {
  blockedReason: RuntimeTerminalWaitBlockedReason | null
  /** The agent's own ready prompt, by the same body rules tui-idle settles on. */
  showsReadyPrompt: boolean
}

/**
 * Judges the line-tail arbiter's verdict against the rendered screen, as the tui-idle poll does.
 * `screen` undefined means the runtime holds no current whole-screen model, so the tail verdict
 * stands: missing evidence neither clears nor blocks.
 */
export function judgeBlockedAgainstLiveScreen(input: {
  tailVerdict: RuntimeTerminalWaitBlockedReason | null
  /** The tail shows blocked text at all, whatever the arbiter made of it. */
  tailShowsBlockedText: boolean
  screen: LiveScreenBlockedEvidence | undefined
  /** A working or explicit-idle title, or a fresh non-permission hook status. */
  agentSaysNotWaiting: boolean
}): RuntimeTerminalWaitBlockedReason | null {
  const { tailVerdict, screen } = input
  if (!screen) {
    return tailVerdict
  }
  if (screen.blockedReason === null) {
    // Why only over a ready prompt: an idle pane prints nothing, so dialog text and its
    // output-time stamp outlive a dialog the screen has replaced with the composer (STA-9039);
    // a screen showing neither may hold a dialog the detector cannot read there.
    return screen.showsReadyPrompt ? null : tailVerdict
  }
  if (tailVerdict !== null) {
    return screen.blockedReason
  }
  // Why only a dialog the tail lost (Claude's workspace trust): one it shows was already weighed
  // against titles and hooks. Why the agent's word still gates it: mid-turn output can quote one.
  return input.tailShowsBlockedText || input.agentSaysNotWaiting ? null : screen.blockedReason
}

/** Whether the agent's own word outranks a dialog only the screen shows, as in tui-idle's ranking. */
export function agentSaysNotWaiting(
  terminal: { title: string | null; titleStatus: AgentStatus | null },
  explicitStatus: { status: AgentStatus } | null
): boolean {
  return (
    terminal.titleStatus === 'working' ||
    (terminal.title !== null && detectExplicitIdleStatusFromTitle(terminal.title) === 'idle') ||
    (explicitStatus !== null && explicitStatus.status !== 'permission')
  )
}
