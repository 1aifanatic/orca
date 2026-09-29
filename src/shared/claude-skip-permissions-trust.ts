import type { TuiAgent } from './tui-agent'
import { isPosixStartupShell, type AgentStartupShell } from './tui-agent-startup-shell'

/** Undocumented Claude Code variable that skips only its folder-trust prompt. */
export const CLAUDE_TRUST_BYPASS_ENV = 'CLAUDE_CODE_SANDBOXED'

const CLAUDE_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions'

/**
 * `NAME=1 ` when a Claude launch already opts out of Claude's safety prompts. Scoped
 * to that one process on purpose: in the pane's environment it would outlive Claude
 * and let a later plain `claude` in the same shell skip the prompt too. Windows shells
 * have no per-process form, so they keep the prompt.
 */
export function claudeTrustBypassCommandPrefix(args: {
  agent: TuiAgent
  shell: AgentStartupShell
  /** Shell-tokenized launch arguments, so a quoted flag still counts. */
  argTokens: readonly string[]
}): string {
  if (args.agent !== 'claude' && args.agent !== 'claude-agent-teams') {
    return ''
  }
  if (!isPosixStartupShell(args.shell)) {
    return ''
  }
  const terminator = args.argTokens.indexOf('--')
  const flags = terminator === -1 ? args.argTokens : args.argTokens.slice(0, terminator)
  return flags.includes(CLAUDE_SKIP_PERMISSIONS_FLAG) ? `${CLAUDE_TRUST_BYPASS_ENV}=1 ` : ''
}
