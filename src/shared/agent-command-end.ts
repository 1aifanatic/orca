import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import { currentOwner } from './agent-hook-presence-transition'
import type { FinishedCommand } from './command-foreground-tracker'

/** Whether a pane's finished command ended the agent its row reports. One rule for main (local and
 *  WSL panes) and the relay (SSH panes). An owner with a process is decided by the host's process
 *  check instead, and an ended owner or resume remnant holds nothing to end. */
export function commandEndEndsRow(
  row: AgentHookEventPayload | undefined,
  rowUpdatedAt: number | undefined,
  command: FinishedCommand
): boolean {
  // Why: a row reported after the command ended (a run's own Done) is newer than that end.
  if (
    !row ||
    row.providerSessionOnly ||
    row.agentPresence?.ended ||
    (rowUpdatedAt !== undefined && rowUpdatedAt >= command.finishedAt)
  ) {
    return false
  }
  const owner = currentOwner(row)
  if (owner?.process) {
    return false
  }
  const agent = owner?.agent ?? row.payload.agentType
  if (!agent || agent === 'unknown') {
    return false
  }
  const { foreground, startedAt } = command
  if (foreground.kind === 'agent') {
    return foreground.agent === agent
  }
  if (foreground.kind === 'program') {
    return false
  }
  // Why: with no read naming the command, the agent that reported during it is taken as its
  // foreground, as the renderer's command-end drop did.
  return startedAt === null || (rowUpdatedAt !== undefined && rowUpdatedAt >= startedAt)
}
