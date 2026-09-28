/** Where an agent's session runs when that is not the CLI in its pane. `background-server`: a
 *  process that keeps running the session's turns and subagents after the CLI exits (Codex's shared
 *  app-server). The execution host derives it on every publish, and only while the row shows work. */
export type AgentSessionRunner = 'background-server'

export function normalizeAgentSessionRunner(
  value: unknown,
  state: string
): { sessionRunner?: AgentSessionRunner } {
  return value === 'background-server' && state !== 'done' ? { sessionRunner: value } : {}
}
