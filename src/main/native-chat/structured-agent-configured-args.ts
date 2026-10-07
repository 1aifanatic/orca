import type { AgentSessionHandleProvider } from '../../shared/agent-session-provider-handle'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolveTuiAgentLaunchArgs } from '../../shared/tui-agent-launch-defaults'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import { StructuredAgentArgumentsError } from './structured-agent-arguments-error'

/** Use the same grouping rules as terminal launches before the provider filters its owned flags. */
export function structuredAgentConfiguredArgs(
  agent: AgentSessionHandleProvider,
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
    throw new StructuredAgentArgumentsError(
      agent === 'codex' ? 'Codex' : 'Claude',
      'quote',
      'unclosedQuote'
    )
  }
  return parsed.tokens
}
