/**
 * The launch-prompt plan for callers that route sensitive prompts: the decision itself (line, launch
 * file, or paste) is the builder's (`carryLaunchPrompt`), so every launch path shares it.
 */

import type { LaunchFile } from './launch-prompt-file'
import { buildAgentStartupPlan, type AgentStartupPlan } from './tui-agent-startup'

type StartupPlanInputs = Omit<
  Parameters<typeof buildAgentStartupPlan>[0],
  'prompt' | 'allowEmptyPromptLaunch'
>

export type LaunchPromptStartupPlan = {
  plan: AgentStartupPlan | null
  /** Written by the execution host before it types the line naming it. */
  launchFile?: LaunchFile
}

export function planStartupWithLaunchPrompt(
  inputs: StartupPlanInputs,
  prompt: string,
  options: { sensitive?: boolean } = {}
): LaunchPromptStartupPlan {
  const plan = buildAgentStartupPlan({
    ...inputs,
    prompt,
    allowEmptyPromptLaunch: true,
    ...(options.sensitive ? { sensitive: true } : {})
  })
  return { plan, ...(plan?.launchFile ? { launchFile: plan.launchFile } : {}) }
}
