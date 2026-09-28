// The execution host's reader of a Codex pane's parent rollout: Codex's own record of the main
// agent's turns and of its children. Every Codex event catches up on it before it is applied, and
// the rollout watch reads it on a timer while there is something left for it to settle.
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { mainAgentTurnInterrupted } from '../../agent-lead-status-fold'
import { codexRosterToSnapshots } from '../../codex-subagent-roster'
import { reconcileCodexSubagentTranscript } from '../../codex-subagent-transcript'
import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'
import { codexBackgroundServerRunning } from '../../codex-background-server'
import {
  codexMainAgentStatusForPayload,
  codexSessionRunner,
  getOrCreateCodexSubagentRoster,
  getOrCreateCodexSubagentTranscriptState,
  resolveCodexPaneStatus,
  setCodexMainAgentTurnState
} from './codex-state'

/** Catches the pane up on its parent rollout, then applies what it records to the root: a running
 *  root with no turn id adopts the rollout's latest turn if it is open or started in this read
 *  (SessionStart carries no id, nor do some Codex builds' hooks, nor a root restored from disk,
 *  whose first read starts from nothing), and a turn the rollout records ended settles. A child's
 *  hook names its own rollout, so it reads the parent a root event named earlier. */
export function catchUpOnCodexParentRollout(
  state: HookListenerState,
  paneKey: string,
  rootTranscriptPath: string | undefined
): void {
  const transcriptState = rootTranscriptPath
    ? getOrCreateCodexSubagentTranscriptState(state, paneKey)
    : state.codexSubagentTranscriptByPaneKey.get(paneKey)
  const parentPath = rootTranscriptPath ?? transcriptState?.parent.filePath
  if (!transcriptState || !parentPath) {
    return
  }
  const latestBefore = transcriptState.mainTurns.latestTurnId
  reconcileCodexSubagentTranscript(
    transcriptState,
    getOrCreateCodexSubagentRoster(state, paneKey),
    parentPath
  )
  const lead = state.codexLeadStateByPaneKey.get(paneKey)
  const turns = transcriptState.mainTurns
  const adoptable = turns.openTurnId !== undefined || turns.latestTurnId !== latestBefore
  // Why only a root still running: a settled root with no id did not describe a later turn.
  const turnId =
    lead?.turnId ?? (lead?.state !== 'done' && adoptable ? turns.latestTurnId : undefined)
  if (!lead || turnId === undefined) {
    return
  }
  // Why: Codex records a turn's end in its rollout whether or not its Interrupt or Stop hook is
  // delivered, so this settles the turn when that hook is lost (Interrupt is capped at 3s).
  if (turnId !== lead.turnId || turns.ended.has(turnId)) {
    setCodexMainAgentTurnState(state, paneKey, {
      state: lead.state,
      ...(lead.outcome ? { outcome: lead.outcome } : {}),
      turnId,
      model: lead.model
    })
  }
}

/** Whether the rollout can still change a Codex row: a root turn open by its own record or by the
 *  rollout's (unless the root already ended it as cancelled, which is final), or children, each of
 *  which is read from its own rollout. */
export function codexRolloutNeedsWatch(state: HookListenerState, paneKey: string): boolean {
  const transcriptState = state.codexSubagentTranscriptByPaneKey.get(paneKey)
  if (
    state.lastStatusByPaneKey.get(paneKey)?.payload.agentType !== 'codex' ||
    !transcriptState?.parent.filePath
  ) {
    return false
  }
  const lead = state.codexLeadStateByPaneKey.get(paneKey)
  const openTurnId = transcriptState.mainTurns.openTurnId
  return (
    (lead !== undefined && lead.state !== 'done') ||
    (openTurnId !== undefined &&
      !(lead?.outcome === 'cancellation' && lead.turnId === openTurnId)) ||
    (state.codexSubagentRosterByPaneKey.get(paneKey)?.size ?? 0) > 0
  )
}

/** The Codex row's status rebuilt from the pane's records, or undefined when `current` already
 *  shows it. Every other field of `current` is kept. */
function codexRowFromRecords(
  state: HookListenerState,
  paneKey: string,
  current: ParsedAgentStatusPayload
): ParsedAgentStatusPayload | undefined {
  const lead = state.codexLeadStateByPaneKey.get(paneKey)
  if (!lead) {
    return undefined
  }
  const resolution = resolveCodexPaneStatus(state, paneKey, lead)
  const payload = normalizeAgentStatusPayload({
    ...current,
    state: resolution.stateName,
    workingMode: resolution.workingMode,
    interrupted: mainAgentTurnInterrupted(lead),
    sessionRunner: codexSessionRunner(state, paneKey, resolution.stateName),
    subagents: codexRosterToSnapshots(state.codexSubagentRosterByPaneKey.get(paneKey)),
    mainAgent: codexMainAgentStatusForPayload(lead)
  })
  return !payload ||
    (payload.state === current.state &&
      payload.sessionRunner === current.sessionRunner &&
      payload.mainAgent?.state === current.mainAgent?.state &&
      payload.mainAgent?.outcome === current.mainAgent?.outcome &&
      JSON.stringify(payload.subagents) === JSON.stringify(current.subagents))
    ? undefined
    : payload
}

/** Ends what a Codex background server was running once that server is gone: it writes no end
 *  marker when it dies, and nothing else can run its turn or subagents. */
function endCodexWorkOfStoppedServer(
  state: HookListenerState,
  paneKey: string,
  current: ParsedAgentStatusPayload
): void {
  const rolloutPath = state.codexSubagentTranscriptByPaneKey.get(paneKey)?.parent.filePath
  if (
    current.sessionRunner !== 'background-server' ||
    !rolloutPath ||
    codexBackgroundServerRunning(rolloutPath)
  ) {
    return
  }
  const lead = state.codexLeadStateByPaneKey.get(paneKey)
  if (lead && lead.state !== 'done') {
    setCodexMainAgentTurnState(state, paneKey, {
      state: 'done',
      outcome: 'cancellation',
      turnId: lead.turnId,
      model: lead.model
    })
  }
  state.codexSubagentRosterByPaneKey.get(paneKey)?.clear()
}

/** Reads the rollout and rebuilds the pane's Codex row from the records it leaves, as an
 *  observation with no hook name or prompt: it restates the row, it is not a new turn. Returns
 *  undefined when the row's status is unchanged. */
export function observeCodexRollout(
  state: HookListenerState,
  paneKey: string
): AgentHookEventPayload | undefined {
  const current = state.lastStatusByPaneKey.get(paneKey)
  if (current?.payload.agentType !== 'codex') {
    return undefined
  }
  catchUpOnCodexParentRollout(state, paneKey, undefined)
  endCodexWorkOfStoppedServer(state, paneKey, current.payload)
  const payload = codexRowFromRecords(state, paneKey, current.payload)
  if (!payload) {
    return undefined
  }
  return {
    paneKey,
    source: 'codex',
    launchToken: current.launchToken,
    tabId: current.tabId,
    worktreeId: current.worktreeId,
    connectionId: current.connectionId,
    ...(current.providerSession ? { providerSession: current.providerSession } : {}),
    // Why: a turn that only restored rows still hold open is not confirmed live by the rollout.
    ...(current.restoredUnconfirmed && payload.state !== 'done'
      ? { restoredUnconfirmed: true as const }
      : {}),
    payload
  }
}
