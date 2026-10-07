/** Orca's validated saved Arguments refusal. The option has no value or user-authored operand. */
export type AgentSessionArgumentProblem = {
  agent: 'Codex' | 'Claude' | 'Grok'
  option: string
  problem:
    | 'unsupportedOption'
    | 'missingValue'
    | 'multipleValues'
    | 'positionalPrompt'
    | 'unclosedQuote'
}

/** Problems that are about no single option carry this fixed word as their option. */
export const AGENT_SESSION_ARGUMENT_PROBLEM_WORD: Partial<
  Record<AgentSessionArgumentProblem['problem'], string>
> = { positionalPrompt: 'prompt', unclosedQuote: 'quote' }

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
    (agent !== 'Codex' && agent !== 'Claude' && agent !== 'Grok') ||
    (problem !== 'unsupportedOption' &&
      problem !== 'missingValue' &&
      problem !== 'multipleValues' &&
      problem !== 'positionalPrompt' &&
      problem !== 'unclosedQuote') ||
    typeof option !== 'string' ||
    (AGENT_SESSION_ARGUMENT_PROBLEM_WORD[problem] !== undefined
      ? option !== AGENT_SESSION_ARGUMENT_PROBLEM_WORD[problem]
      : !/^(?:--[a-zA-Z][a-zA-Z0-9-]{0,63}|-[a-zA-Z]|--\?)$/.test(option))
  ) {
    return undefined
  }
  return { agent, option, problem }
}
