import type { CommandTokenSpan } from './commit-message-prompt'
import {
  argumentsSetOption,
  bypassFlagGroups,
  classifyTypedAgentPermissions,
  LAUNCH_GRAMMARS,
  optionTokens
} from './tui-agent-permission-args'
import { resolveAgentLaunchGrammar, type AgentLaunchTarget } from './tui-agent-startup-shell'
import { YOLO_TUI_AGENT_ENV } from './tui-agent-permissions'
import type { TuiAgent } from './tui-agent'

// Moves a permission bypass saved inline in an agent's Arguments or env out into its typed mode.

/**
 * Where these exact words of the flag start in `tokens`, or -1. Matching the raw text (not the
 * parsed word) means a quoted or escaped spelling is never cut, so the cut means the same thing
 * under every shell; anything else stays in the text and is read with the launch's shell.
 */
function findTokenSequence(
  text: string,
  tokens: { spans: CommandTokenSpan[] },
  rawSequence: readonly string[]
): number {
  return tokens.spans.findIndex(
    (_, index) =>
      index + rawSequence.length <= tokens.spans.length &&
      rawSequence.every((raw, offset) => {
        const span = tokens.spans[index + offset]
        return text.slice(span.start, span.end) === raw
      })
  )
}

/**
 * Finds the flag's words under POSIX, else PowerShell grammar (Windows paths like `C:\dir\` glue
 * onto the next word under POSIX); cmd only when neither parses, since cmd would read inside single quotes.
 */
function findBypassFlag(
  text: string,
  rawFlag: readonly string[]
): { tokens: { spans: CommandTokenSpan[] }; at: number } | null {
  let parsed = false
  for (const shell of ['posix', 'powershell'] as const) {
    const tokens = optionTokens(text, shell)
    if (tokens.ok) {
      parsed = true
      const at = findTokenSequence(text, tokens, rawFlag)
      if (at !== -1) {
        return { tokens, at }
      }
    }
  }
  const cmd = parsed ? null : optionTokens(text, 'cmd')
  const at = cmd?.ok ? findTokenSequence(text, cmd, rawFlag) : -1
  return cmd?.ok && at !== -1 ? { tokens: cmd, at } : null
}

/**
 * Cuts each option of the bypass flag out of the text. A companion option the user set to another
 * value stays theirs; if any other part is missing the flag never launched whole, so nothing is cut.
 */
function stripBypassFlag(agent: TuiAgent, args: string): string {
  let text = args
  for (const group of bypassFlagGroups(agent)) {
    let hit = findBypassFlag(text, group.rawTokens)
    const found = hit !== null
    while (hit) {
      const { tokens, at } = hit
      const before = text.slice(0, tokens.spans[at].start).trimEnd()
      const after = text.slice(tokens.spans[at + group.rawTokens.length - 1].end).trimStart()
      text = before && after ? `${before} ${after}` : before || after
      hit = findBypassFlag(text, group.rawTokens)
    }
    const userSetsIt = LAUNCH_GRAMMARS.every((grammar) =>
      argumentsSetOption(text, group.option, [grammar])
    )
    if (!found && (group.permission || !userSetsIt)) {
      return args
    }
  }
  return text
}

/**
 * The text with the canonical bypass flag cut out, or unchanged when the rest would still set
 * permissions under some shell (a launch there would add no flag back, so cutting would lose it).
 */
export function cutTuiAgentBypassFlag(agent: TuiAgent, args: string | null | undefined): string {
  const original = args?.trim() ?? ''
  const rest = stripBypassFlag(agent, original)
  const restSetsNothing = LAUNCH_GRAMMARS.every(
    (grammar) => classifyTypedAgentPermissions(agent, { args: rest }, grammar).kind === 'none'
  )
  return rest !== original && restSetsNothing ? rest : original
}

/**
 * Splits the bypass flag out of arguments saved with it inline, keeping the rest's quoting. Text
 * left whole reads as bypass when it holds the flag or bypasses at `target` (an alias like `-y`).
 */
export function liftTuiAgentBypassArgs(
  agent: TuiAgent,
  args: string | null | undefined,
  target: AgentLaunchTarget
): { bypass: boolean; extraArgs: string } {
  const original = args?.trim() ?? ''
  const extraArgs = cutTuiAgentBypassFlag(agent, original)
  const bypass =
    extraArgs !== original ||
    stripBypassFlag(agent, original) !== original ||
    classifyTypedAgentPermissions(agent, { args: original }, resolveAgentLaunchGrammar(target))
      .kind === 'bypass'
  return { bypass, extraArgs }
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
