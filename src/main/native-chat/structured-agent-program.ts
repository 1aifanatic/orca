import { resolveConfiguredCliProgram } from '../../shared/configured-cli-program'
import {
  resolveCliCommand,
  type ResolveCommandOptions
} from '../../shared/node-cli-command-resolution'
import { AgentSessionPreSpawnError } from './agent-session-wire/structured-agent-session-adapter'

/**
 * The program a structured chat (and its model-catalog probe) runs: Settings → Agents → Command
 * when set, else the stock CLI. A set Command that is not runnable refuses the launch rather than
 * quietly running the stock CLI in its place.
 */
export function resolveStructuredAgentProgram(
  agent: 'claude' | 'codex',
  configured: string | null | undefined,
  options: ResolveCommandOptions = {}
): string {
  if (!configured?.trim()) {
    return resolveCliCommand(agent, options)
  }
  const program = resolveConfiguredCliProgram(configured, options)
  if (!program) {
    throw new AgentSessionPreSpawnError(
      `the ${agent} Command setting is not a runnable program: ${configured}`,
      { reason: 'agentCommandNotRunnable' }
    )
  }
  return program
}
