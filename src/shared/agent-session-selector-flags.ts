import { isResumableTuiAgent, type ResumableTuiAgent } from './agent-session-resume'
import type { TuiAgent } from './tui-agent'

/** Flags that choose, continue, fork, or import a session, seeded from each CLI's `--help`.
 *  Why: resume appends Orca's own selector (`getAgentResumeArgv`), so a typed one would compete. */
export const AGENT_SESSION_SELECTOR_FLAGS: Record<ResumableTuiAgent, readonly string[]> = {
  claude: [
    '--resume',
    '-r',
    '--continue',
    '-c',
    '--fork-session',
    '--session-id',
    '--from-pr',
    '--teleport',
    '--cloud'
  ],
  codebuddy: ['--resume', '-r', '--continue', '-c'],
  // Codex selects sessions through its `resume` and `fork` subcommands instead.
  codex: [],
  qoder: ['--resume'],
  gemini: ['--resume', '-r', '--session-file', '--session-id'],
  antigravity: ['--conversation', '--continue', '-c'],
  opencode: ['--session', '-s', '--continue', '-c'],
  opencode2: ['--session', '-s', '--continue', '-c'],
  pi: ['--session', '--resume', '-r', '--continue', '-c', '--fork'],
  'mimo-code': ['--session'],
  droid: ['--resume', '-r', '--fork'],
  grok: ['--resume', '-r', '--load', '--continue', '-c', '--fork-session', '--session-id', '-s'],
  devin: ['--resume'],
  omp: ['--resume', '-r', '--continue', '-c', '--from-claude', '--from-codex'],
  'prime-agent': ['--resume'],
  copilot: ['--resume'],
  kimi: ['--session'],
  muse: [],
  zcode: ['--resume'],
  dsh: ['--resume', '--continue']
}

/** Session subcommands a CLI still dispatches after flags: `codex --search resume --last`. */
export const AGENT_SESSION_SUBCOMMANDS: Partial<Record<TuiAgent, readonly string[]>> = {
  codex: ['resume', 'fork'],
  muse: ['resume']
}

export function getAgentSessionSelectorFlags(agent: TuiAgent): readonly string[] {
  return isResumableTuiAgent(agent) ? AGENT_SESSION_SELECTOR_FLAGS[agent] : []
}
