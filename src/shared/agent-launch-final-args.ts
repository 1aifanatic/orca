import {
  extraAgentArgsError,
  type ExtraAgentArgsError,
  type ExtraAgentArgsErrorCode,
  type ExtraAgentArgsErrorSource
} from './agent-extra-args-errors'
import type { AgentStartupPlanInputs } from './agent-startup-plan-inputs'
import { resolveHermesStartupQuery, type HermesStartupQueryFailure } from './hermes-startup-query'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import { resolveStartupShell } from './tui-agent-startup-shell'

export type AgentLaunchFinalArgs =
  | { ok: true; args: string[] }
  | { ok: false; error: ExtraAgentArgsError }

const HERMES_FAILURES: Record<
  HermesStartupQueryFailure,
  { code: ExtraAgentArgsErrorCode; source: ExtraAgentArgsErrorSource }
> = {
  'unparseable-command': { code: 'override-unclosed-quote', source: 'override' },
  'unparseable-agent-args': { code: 'defaults-unclosed-quote', source: 'defaults' },
  'no-hermes-executable': { code: 'hermes-no-executable', source: 'override' },
  'env-assignments-need-posix': { code: 'hermes-env-assignments', source: 'override' },
  'too-large': { code: 'hermes-too-large', source: 'extras' }
}

/** The arguments the agent gets after its command, without Orca's own prompt and draft tokens. */
export function resolveAgentLaunchFinalArgs(
  inputs: AgentStartupPlanInputs,
  launch: { prompt: string }
): AgentLaunchFinalArgs {
  const shell = resolveStartupShell(inputs.platform, inputs.shell)
  const prompt = launch.prompt.trim()
  const usesQuery = TUI_AGENT_CONFIG[inputs.agent].promptInjectionMode === 'hermes-query' && prompt
  const resolved = resolveAgentLaunchCommand({
    ...inputs,
    shell,
    agentArgs: usesQuery ? null : inputs.agentArgs
  })
  if (!resolved.ok) {
    return {
      ok: false,
      error: extraAgentArgsError('launch-command', 'defaults', { detail: resolved.error })
    }
  }
  if (!usesQuery) {
    return { ok: true, args: resolved.args }
  }
  const query = resolveHermesStartupQuery({
    baseCommand: resolved.command,
    agentArgs: inputs.agentArgs,
    prompt,
    agentEnv: inputs.agentEnv,
    platform: inputs.platform,
    shell,
    isRemote: inputs.isRemote
  })
  if (!query.ok) {
    const { code, source } = HERMES_FAILURES[query.cause]
    return { ok: false, error: extraAgentArgsError(code, source, { agent: 'Hermes' }) }
  }
  return { ok: true, args: query.keptAgentArgs }
}
