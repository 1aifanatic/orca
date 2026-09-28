import type { AgentStatusEntry } from './agent-status-types'

/** Whether an agent CLI leaving its pane ends the pane's agent row.
 *
 *  It does unless the execution host reports the row's work running in a background server that
 *  outlives the CLI (Codex's shared app-server after "Run in background", or "Exit" with a subagent
 *  still running). That work still posts hooks to this pane, and the host ends the row from the
 *  server's own records, or when the server itself is gone. A CLI that runs its session itself
 *  takes the work with it, even when killed mid-turn. */
export function cliExitEndsAgentRow(
  row: Pick<AgentStatusEntry, 'state' | 'sessionRunner'>
): boolean {
  return row.state === 'done' || row.sessionRunner !== 'background-server'
}
