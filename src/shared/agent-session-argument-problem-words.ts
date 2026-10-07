// The sentences after "{agent} couldn't start." for a saved Arguments refusal: what is wrong, where
// to change it, and for some options what a chat honors instead. Chosen from the option name alone,
// which every client already receives.

import type { AgentSessionArgumentProblem } from './agent-session-argument-problem'
import type {
  AgentSessionFailureCopyId,
  AgentSessionFailureSay
} from './agent-session-failure-copy'

const PROBLEM_COPY = {
  unsupportedOption: 'argumentsUnsupportedOption',
  missingValue: 'argumentsMissingValue',
  multipleValues: 'argumentsMultipleValues',
  positionalPrompt: 'argumentsPositionalPrompt',
  unclosedQuote: 'argumentsUnclosedQuote'
} as const satisfies Record<AgentSessionArgumentProblem['problem'], AgentSessionFailureCopyId>

/** Codex options a chat refuses that have an equivalent, or no need, in a chat. */
const CODEX_OPTION_HINTS = new Map<string, AgentSessionFailureCopyId>([
  ['--profile', 'argumentsProfileHint'],
  ['-p', 'argumentsProfileHint'],
  ['--oss', 'argumentsProviderHint'],
  ['--local-provider', 'argumentsProviderHint'],
  ['-C', 'argumentsWorkspaceHint'],
  ['--cd', 'argumentsWorkspaceHint'],
  ['--add-dir', 'argumentsWorkspaceHint'],
  ['--worktree', 'argumentsWorkspaceHint'],
  ['-i', 'argumentsImageHint'],
  ['--image', 'argumentsImageHint']
])

function problemCopy({ option, problem }: AgentSessionArgumentProblem): AgentSessionFailureCopyId {
  if (problem === 'unsupportedOption' && option === '--?') {
    return 'argumentsUnnamedOption'
  }
  return PROBLEM_COPY[problem]
}

export function agentSessionArgumentProblemSentences(
  argumentProblem: AgentSessionArgumentProblem,
  say: AgentSessionFailureSay
): string[] {
  const { agent, option, problem } = argumentProblem
  const hint =
    agent === 'Codex' && problem === 'unsupportedOption'
      ? CODEX_OPTION_HINTS.get(option)
      : undefined
  return [
    say(problemCopy(argumentProblem), { agent, option }),
    say(
      problem === 'unsupportedOption' || problem === 'positionalPrompt'
        ? 'removeFromSavedArguments'
        : 'editSavedArguments',
      { agent }
    ),
    ...(hint ? [say(hint)] : [])
  ]
}
