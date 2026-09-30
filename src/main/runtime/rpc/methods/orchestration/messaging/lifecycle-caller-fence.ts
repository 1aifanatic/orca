import type { OrchestrationCompatibilityEvidence } from '../../../../../../shared/orchestration-compatibility-evidence'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isEquivalentPaneKey } from '../../../../orchestration/db/pane-key-match'

/**
 * Refuses a worker report or question sent from another orchestration party's terminal: a Run
 * coordinator or the assignee of a different Dispatch. Env that names no live pane on this host
 * (stale, foreign, scrubbed, absent) proves nothing, so tmux servers, teammates and old CLIs pass.
 */
export function assertLifecycleCallerIsNotAnotherParty(
  runtime: OrcaRuntimeService,
  args: {
    from: string
    fromPaneKey: string | undefined
    evidence: OrchestrationCompatibilityEvidence | undefined
  }
): void {
  const { evidence } = args
  // Why pane key first: the env handle goes stale on remint, the pane key does not.
  const callerHandle = evidence?.paneKey
    ? runtime.getTerminalHandleForPaneKey(evidence.paneKey)
    : evidence?.terminalHandle
  const callerPaneKey = callerHandle ? runtime.getLiveTerminalPaneKey(callerHandle) : null
  if (
    !callerHandle ||
    !callerPaneKey ||
    (args.fromPaneKey && isEquivalentPaneKey(callerPaneKey, args.fromPaneKey))
  ) {
    return
  }
  const db = runtime.getOrchestrationDb()
  const party = db.getCurrentRunForPane(callerPaneKey)
    ? 'a Run coordinator'
    : db.getActiveDispatchForIdentity(callerHandle, callerPaneKey) ||
        db.findActiveRemoteAttachmentForPane(callerPaneKey)
      ? 'the worker of another Dispatch'
      : undefined
  if (party) {
    throw new OrchestrationError(
      'consumer_fenced',
      `This terminal is ${party} and cannot report as ${args.from}; run the command from the worker's own terminal. No effects were applied.`,
      { effectsApplied: false }
    )
  }
}
