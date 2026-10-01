import type { SleepingAgentLaunchConfig } from './agent-session-resume'

export function buildSleepingAgentLaunchConfig(args: {
  agentCommand?: string | null
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  ompResumeFilePath?: string | null
}): SleepingAgentLaunchConfig {
  return {
    ...(args.agentCommand?.trim() ? { agentCommand: args.agentCommand } : {}),
    agentArgs: args.agentArgs ?? '',
    // Why: startup env may include prompt transport or pane identity values;
    // durable resume state is limited to Orca-managed agent inputs.
    agentEnv: args.agentEnv ? { ...args.agentEnv } : {},
    ...(args.ompResumeFilePath?.trim() ? { ompResumeFilePath: args.ompResumeFilePath.trim() } : {})
  }
}

export function launchConfigsEqual(
  a: SleepingAgentLaunchConfig | undefined,
  b: SleepingAgentLaunchConfig | undefined
): boolean {
  if (a === undefined || b === undefined) {
    return a === b
  }
  if (
    a.agentCommand !== b.agentCommand ||
    a.agentArgs !== b.agentArgs ||
    a.ompResumeFilePath !== b.ompResumeFilePath
  ) {
    return false
  }
  const aKeys = Object.keys(a.agentEnv)
  const bKeys = Object.keys(b.agentEnv)
  return aKeys.length === bKeys.length && aKeys.every((key) => a.agentEnv[key] === b.agentEnv[key])
}
