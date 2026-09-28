/**
 * Whether a launch prompt rides the command line that gets TYPED into the user's shell, or the agent
 * starts clean and the prompt is pasted once it is ready.
 *
 * Measured on the built line, not the raw prompt: quoting, the launcher, its arguments and session
 * options all land on that line, and every failure a long or multi-line typed line has is a property
 * of the line — macOS bash 3.2 reads each newline as Enter, a canonical-mode write truncates a line
 * past MAX_CANON (1024 on macOS), and cmd caps a line at 8191. Decided here, where the line exists,
 * so the answer is a fact about what was built rather than a prediction of it.
 */

import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { buildAgentStartupPlan, type AgentStartupPlan } from './tui-agent-startup'
import type { TuiAgent } from './tui-agent'

/** Half of macOS MAX_CANON: a single typed line this long survived every canonical-mode write
 *  measured, and 1 KiB did not. */
export const TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES = 512

const encoder = new TextEncoder()

function typedLineBytes(line: string): number {
  return encoder.encode(line).byteLength
}

export function startupLineCarriesPrompt(args: {
  agent: TuiAgent
  withPrompt: AgentStartupPlan | null
}): boolean {
  const { withPrompt } = args
  if (!withPrompt || withPrompt.followupPrompt !== null) {
    return false
  }
  // Hermes types a fixed line that reads the prompt from the spawn env, so the line never grows
  // with the text; its own env budget already returned null above when the text did not fit.
  if (TUI_AGENT_CONFIG[args.agent].promptInjectionMode === 'hermes-query') {
    return true
  }
  const line = withPrompt.launchCommand
  return !/[\r\n]/.test(line) && typedLineBytes(line) <= TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES
}

type StartupPlanInputs = Omit<
  Parameters<typeof buildAgentStartupPlan>[0],
  'prompt' | 'allowEmptyPromptLaunch'
>

/**
 * The startup plan for a launch that offers a prompt: the prompted plan when its typed line can
 * carry the text, else the clean plan, with which one it was.
 */
export function planStartupWithPromptCandidate(
  inputs: StartupPlanInputs,
  prompt: string
): { plan: AgentStartupPlan | null; promptCarried: boolean } {
  if (prompt.trim()) {
    const withPrompt = buildAgentStartupPlan({ ...inputs, prompt, allowEmptyPromptLaunch: true })
    if (startupLineCarriesPrompt({ agent: inputs.agent, withPrompt })) {
      return { plan: withPrompt, promptCarried: true }
    }
  }
  return {
    plan: buildAgentStartupPlan({ ...inputs, prompt: '', allowEmptyPromptLaunch: true }),
    promptCarried: false
  }
}
