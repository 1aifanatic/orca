// One live ACP child and what Orca keeps beside it, and how its traffic and its exit reach the
// journal and the host.

import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import type { StructuredAgentSessionEndedEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { UNVERIFIABLE_TURN_VERDICT } from '../native-chat/agent-session-wire/structured-agent-session-stale-turn-verdict'
import type { AcpLaunchSpec } from './acp-launch-specs'
import type { AcpSessionEvent, AcpSessionRuntime } from './acp-session-runtime'
import type { AcpStructuredChild } from './acp-structured-child'
import type { AcpStructuredLane } from './acp-structured-lane'
import type { AcpStructuredOptions } from './acp-structured-options'
import type { AcpStructuredPrompts } from './acp-structured-prompts'
import type { AcpStructuredTurns } from './acp-structured-turns'

export type AcpStructuredSession = {
  sessionId: string
  fence: number
  acquisitionGeneration: string
  spec: AcpLaunchSpec
  child: AcpStructuredChild
  runtime: AcpSessionRuntime
  lane: AcpStructuredLane
  prompts: AcpStructuredPrompts
  options: AcpStructuredOptions
  turns: AcpStructuredTurns
  /** Saved picks the agent refused when this child started. */
  restoreSkipped: readonly string[]
  /** Orca asked this child to stop; its exit is then a requested close. */
  closeRequested: boolean
  ended: boolean
  exitObservedAt: number | null
  unbindReadingControl?: () => void
}

/** Every agent frame goes through here once the lane exists: options and commands first, so a
 *  read right after the frame sees them, then the journal. */
export function routeAcpSessionEvent(
  session: Pick<AcpStructuredSession, 'lane' | 'options'>,
  event: AcpSessionEvent,
  at: number
): void {
  if (event.kind === 'known') {
    const { update } = event.notification
    if (update.sessionUpdate === 'available_commands_update') {
      session.options.adoptCommands(update.availableCommands)
    } else if (update.sessionUpdate === 'config_option_update') {
      session.options.adoptConfigOptions(update.configOptions)
    }
  }
  session.lane.apply(session.lane.translator.sessionEvent(event, at))
}

/**
 * The child's exit, once. Open requests die with it, held sends never left Orca, the running turn
 * is one the host never heard end (`unverifiable` until death evidence revises it), and the host
 * hears `ended` so it releases the session.
 */
export function endAcpStructuredSession(
  session: AcpStructuredSession,
  observedAt: number,
  onEvent: ((event: StructuredAgentSessionEndedEvent) => void) | undefined
): void {
  if (session.ended) {
    return
  }
  session.ended = true
  session.exitObservedAt = observedAt
  const stderr = session.child.stderrTail()
  const reason = session.closeRequested
    ? `${session.spec.agent} ACP agent closed by Orca`
    : `${session.spec.agent} ACP agent exited${stderr ? `: ${stderr}` : ''}`
  session.prompts.clear()
  session.turns.end(reason)
  session.lane.apply([{ type: 'session.ended', verdict: UNVERIFIABLE_TURN_VERDICT }])
  session.lane.flush()
  session.lane.dispose()
  session.unbindReadingControl?.()
  session.runtime.close(new Error(reason))
  const detail = stderr ? providerDiagnostic(stderr, 'person') : undefined
  onEvent?.({
    type: 'ended',
    sessionId: session.sessionId,
    reason,
    failure: session.closeRequested
      ? agentSessionFailureFact('hostFault')
      : agentSessionFailureFact('providerExited', detail ? { detail } : {}),
    cause: session.closeRequested ? 'requested-close' : 'unexpected-exit',
    fence: session.fence,
    acquisitionGeneration: session.acquisitionGeneration,
    observedAt
  })
}
