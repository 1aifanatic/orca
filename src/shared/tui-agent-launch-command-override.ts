import type { GlobalSettings } from './global-settings-types'
import type { TuiAgent } from './tui-agent'

/**
 * Whether the user replaced this agent's launch command.
 *
 * Never a route input: a terminal types it as a command line, and structured native chat runs it as
 * the program. Terminal-backed chat reads it to skip the structured model catalog, which models
 * only that program, not the whole command line this terminal runs.
 */
export function hasExplicitTuiLaunchCommand(
  settings: Partial<Pick<GlobalSettings, 'agentCmdOverrides'>> | null | undefined,
  agent: TuiAgent
): boolean {
  return Boolean(settings?.agentCmdOverrides?.[agent]?.trim())
}
