import type { AgentSessionArgumentProblem } from '../../shared/agent-session-failure'
import { AGENT_SESSION_ARGUMENT_PROBLEM_WORD } from '../../shared/agent-session-argument-problem'

/** A saved Arguments refusal with only the option name, never its value. */
export class StructuredAgentArgumentsError extends Error {
  readonly argumentProblem: AgentSessionArgumentProblem

  constructor(
    agent: AgentSessionArgumentProblem['agent'],
    option: string,
    problem: AgentSessionArgumentProblem['problem'],
    /** What the agent itself reported, kept for the log. */
    cause?: unknown
  ) {
    const normalizedOption =
      AGENT_SESSION_ARGUMENT_PROBLEM_WORD[problem] ??
      option.match(/^--[a-zA-Z][a-zA-Z0-9-]{0,63}/)?.[0] ??
      option.match(/^-[a-zA-Z]/)?.[0] ??
      '--?'
    super(
      `${agent} structured chat cannot use ${normalizedOption} in saved Arguments`,
      cause === undefined ? undefined : { cause }
    )
    this.name = 'StructuredAgentArgumentsError'
    this.argumentProblem = { agent, option: normalizedOption, problem }
  }
}

/** Finds a typed Arguments refusal through acquisition wrappers. */
export function argumentProblemOf(
  error: unknown,
  depth = 0
): AgentSessionArgumentProblem | undefined {
  if (depth >= 6 || !(error instanceof Error)) {
    return undefined
  }
  if (error instanceof StructuredAgentArgumentsError) {
    return error.argumentProblem
  }
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      const problem = argumentProblemOf(inner, depth + 1)
      if (problem) {
        return problem
      }
    }
  }
  return argumentProblemOf(error.cause, depth + 1)
}
