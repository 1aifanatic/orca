import { basename, win32 } from 'node:path'
import type { TuiAgent } from '../../../shared/tui-agent'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import {
  resolveStartupShell,
  tokenizeStartupCommand
} from '../../../shared/tui-agent-startup-shell'
import { OrchestrationError } from './orchestration-error'

export function resolveConfiguredWorkerAgent(
  selector: string,
  overrides: Partial<Record<TuiAgent, string>>,
  platform: NodeJS.Platform = process.platform
): TuiAgent | undefined {
  if (isTuiAgent(selector)) {
    return selector
  }
  const matches: TuiAgent[] = []
  for (const [agent, command] of Object.entries(overrides)) {
    if (!isTuiAgent(agent) || !command) {
      continue
    }
    const parsed = tokenizeStartupCommand(command, resolveStartupShell(platform))
    // A command wrapper cannot attest which CLI grammar its arguments implement.
    if (!parsed.ok || parsed.tokens.length !== 1) {
      continue
    }
    const executable = parsed.tokens[0]
    const name = (
      executable.includes('\\') ? win32.basename(executable) : basename(executable)
    ).replace(/\.(?:exe|cmd|bat)$/i, '')
    if (name === selector) {
      matches.push(agent)
    }
  }
  if (matches.length > 1) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `Agent command ${selector} is configured for multiple launchers. Use a canonical agent ID.`
    )
  }
  return matches[0]
}
