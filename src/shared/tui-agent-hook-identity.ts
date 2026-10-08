import type { TuiAgent } from './tui-agent'

// Why: these launches run Claude Code's hooks (Agent Teams wraps `claude`; OpenClaude's managed
// script posts to the Claude route), so their hook events name `claude`. Every other launch's
// hooks name the launched agent itself.
const HOOK_AGENT_BY_LAUNCH: ReadonlyMap<string, string> = new Map<TuiAgent, string>([
  ['claude-agent-teams', 'claude'],
  ['openclaude', 'claude']
])

/** The agent a launched agent's hook events name. */
export function hookAgentForLaunch(launchAgent: string): string {
  return HOOK_AGENT_BY_LAUNCH.get(launchAgent) ?? launchAgent
}
