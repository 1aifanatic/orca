import type { AgentStatusEntry } from './agent-status-types'

/** Whether an agent CLI leaving its pane ends the pane's agent row.
 *
 *  It does for every agent except a Codex row that still shows work and names its rollout. Codex's
 *  turn and subagents run in its app-server, and a shared background server keeps running them
 *  after the TUI exits ("Run in background", or "Exit" with a subagent still running), still
 *  posting hooks to this pane. The execution host reads that rollout, so Codex's own records end
 *  the row; a TUI that exits with nothing left running writes the end into the rollout too. */
export function cliExitEndsAgentRow(
  row: Pick<AgentStatusEntry, 'agentType' | 'state' | 'providerSession'>
): boolean {
  return !(
    row.agentType === 'codex' &&
    row.state !== 'done' &&
    row.providerSession?.transcriptPath !== undefined
  )
}
