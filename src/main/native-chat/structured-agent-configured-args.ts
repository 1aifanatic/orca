import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolveTuiAgentLaunchArgs } from '../../shared/tui-agent-launch-defaults'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import { StructuredAgentArgumentsError } from './structured-agent-arguments-error'
import type { AgentSessionArgumentProblem } from '../../shared/agent-session-argument-problem'

const AGENT_NAMES = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok'
} as const satisfies Record<string, AgentSessionArgumentProblem['agent']>

/** Use the same grouping rules as terminal launches before the provider filters its owned flags. */
export function structuredAgentConfiguredArgs(
  agent: keyof typeof AGENT_NAMES,
  settings: Partial<Pick<GlobalSettings, 'agentDefaultArgs' | 'terminalWindowsShell'>>,
  platform: NodeJS.Platform = process.platform
): string[] {
  const shell =
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote: false,
      terminalWindowsShell: settings.terminalWindowsShell
    }) ?? 'posix'
  const parsed = tokenizeStartupCommand(
    resolveTuiAgentLaunchArgs(agent, settings.agentDefaultArgs),
    shell
  )
  // An unclosed quote is the tokenizer's only failure.
  if (!parsed.ok) {
    throw new StructuredAgentArgumentsError(AGENT_NAMES[agent], 'quote', 'unclosedQuote')
  }
  return parsed.tokens
}
