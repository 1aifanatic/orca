/** Orca's validated saved Arguments refusal. The option has no value or user-authored operand. */
export type AgentSessionArgumentProblem = {
  agent: 'Codex' | 'Claude'
  option: string
  problem:
    | 'unsupportedOption'
    | 'missingValue'
    | 'multipleValues'
    | 'invalidValue'
    | 'positionalPrompt'
    | 'unclosedQuote'
}

/** The Codex settings a saved value can be invalid for, by their config key. */
export const CODEX_ARGUMENT_SETTINGS = [
  'sandbox_mode',
  'approval_policy',
  'approvals_reviewer'
] as const
export type CodexArgumentSetting = (typeof CODEX_ARGUMENT_SETTINGS)[number]

/** Problems that aren't about the option as typed carry one of these fixed words as their option:
 *  a value names the setting it is for, however the Arguments spelled it. */
export const AGENT_SESSION_ARGUMENT_PROBLEM_WORDS: Partial<
  Record<AgentSessionArgumentProblem['problem'], readonly string[]>
> = {
  positionalPrompt: ['prompt'],
  unclosedQuote: ['quote'],
  invalidValue: CODEX_ARGUMENT_SETTINGS
}

export function readAgentSessionArgumentProblem(
  value: unknown
): AgentSessionArgumentProblem | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('agent' in value) ||
    !('problem' in value) ||
    !('option' in value)
  ) {
    return undefined
  }
  const agent = value.agent
  const problem = value.problem
  const option = value.option
  if (
    (agent !== 'Codex' && agent !== 'Claude') ||
    (problem !== 'unsupportedOption' &&
      problem !== 'missingValue' &&
      problem !== 'multipleValues' &&
      problem !== 'invalidValue' &&
      problem !== 'positionalPrompt' &&
      problem !== 'unclosedQuote') ||
    typeof option !== 'string' ||
    !(
      AGENT_SESSION_ARGUMENT_PROBLEM_WORDS[problem]?.includes(option) ??
      /^(?:--[a-zA-Z][a-zA-Z0-9-]{0,63}|-[a-zA-Z]|--\?)$/.test(option)
    )
  ) {
    return undefined
  }
  return { agent, option, problem }
}
