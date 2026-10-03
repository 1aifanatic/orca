import type { CommandTokenSpan } from './commit-message-prompt'
import {
  bypassFlagTokens,
  classifyTypedAgentPermissions,
  isQuotedToken,
  optionTokens
} from './tui-agent-permission-args'
import { YOLO_TUI_AGENT_ENV } from './tui-agent-permissions'
import type { TuiAgent } from './tui-agent'

// Moves a permission bypass saved inline in an agent's Arguments or env out into its typed mode.

/** Where this unquoted token sequence starts in `tokens`, or -1. */
function findTokenSequence(
  text: string,
  tokens: { tokens: string[]; spans: CommandTokenSpan[] },
  sequence: readonly string[]
): number {
  return tokens.tokens.findIndex(
    (_, index) =>
      index + sequence.length <= tokens.tokens.length &&
      !isQuotedToken(text, tokens.spans[index]) &&
      sequence.every((token, offset) => tokens.tokens[index + offset] === token)
  )
}

/**
 * Finds the flag under POSIX, else PowerShell grammar (Windows paths like `C:\dir\` mis-split
 * under POSIX); cmd only when neither parses, since cmd would read inside single quotes.
 */
function findBypassFlag(
  text: string,
  flag: readonly string[]
): { tokens: { tokens: string[]; spans: CommandTokenSpan[] }; at: number } | null {
  let parsed = false
  for (const shell of ['posix', 'powershell'] as const) {
    const tokens = optionTokens(text, shell)
    if (tokens.ok) {
      parsed = true
      const at = findTokenSequence(text, tokens, flag)
      if (at !== -1) {
        return { tokens, at }
      }
    }
  }
  const cmd = parsed ? null : optionTokens(text, 'cmd')
  const at = cmd?.ok ? findTokenSequence(text, cmd, flag) : -1
  return cmd?.ok && at !== -1 ? { tokens: cmd, at } : null
}

function stripBypassFlag(agent: TuiAgent, args: string): string {
  const flag = bypassFlagTokens(agent)
  let text = args
  while (flag.length > 0 && text) {
    const found = findBypassFlag(text, flag)
    if (!found) {
      break
    }
    const { tokens, at } = found
    const before = text.slice(0, tokens.spans[at].start).trimEnd()
    const after = text.slice(tokens.spans[at + flag.length - 1].end).trimStart()
    text = before && after ? `${before} ${after}` : before || after
  }
  return text
}

/**
 * Splits the bypass flag out of arguments saved with it inline, keeping the rest's quoting. Text
 * that still sets permissions stays whole, since a launch adds no flag beside it; it reads as
 * bypass when it bypasses (an alias such as Gemini `-y`) or holds the flag.
 */
export function liftTuiAgentBypassArgs(
  agent: TuiAgent,
  args: string | null | undefined
): { bypass: boolean; extraArgs: string } {
  const original = args?.trim() ?? ''
  const typed = classifyTypedAgentPermissions(agent, { args: original }).kind
  if (typed === 'none') {
    return { bypass: false, extraArgs: original }
  }
  const rest = stripBypassFlag(agent, original)
  if (rest !== original && classifyTypedAgentPermissions(agent, { args: rest }).kind === 'none') {
    return { bypass: true, extraArgs: rest }
  }
  return { bypass: typed === 'bypass' || rest !== original, extraArgs: original }
}

/** Splits this agent's env-driven permission bypass out of an environment record. */
export function liftTuiAgentBypassEnv(
  agent: TuiAgent,
  env: Record<string, string> | null | undefined
): { bypass: boolean; extraEnv: Record<string, string> } {
  const extraEnv = { ...env }
  const bypassEnv = YOLO_TUI_AGENT_ENV[agent]
  if (!bypassEnv || !Object.entries(bypassEnv).every(([name, value]) => extraEnv[name] === value)) {
    return { bypass: false, extraEnv }
  }
  for (const name of Object.keys(bypassEnv)) {
    delete extraEnv[name]
  }
  return { bypass: true, extraEnv }
}
