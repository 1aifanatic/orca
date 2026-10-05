import { agentArgTerminatorIndex } from './agent-session-option-agent-args'
import {
  extraArgsFamilyIsPresent,
  findRepeatedFamily,
  getExtraArgsFamilies,
  type ExtraArgsFamily
} from './agent-extra-args-families'
import { extraAgentArgsError, type ExtraAgentArgsError } from './agent-extra-args-errors'
import {
  checkExtraTokenShape,
  checkOrcaOwnedFlags,
  checkPromptPlacement,
  checkWindowsTokens,
  getAgentBypassFlags,
  hasAgentExtraArgsFlag
} from './agent-extra-args-token-checks'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import type { AgentStartupPlanInputs } from './agent-startup-plan-inputs'
import { findFreshOmpLaunchBlocker } from './omp-fresh-launch'
import { MAX_AGENT_ARGS_BYTES } from './agent-launch-limits'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'
import type { TuiAgent } from './tui-agent'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import {
  resolveStartupShell,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

export type AppliedExtraAgentArgs =
  | { ok: true; inputs: AgentStartupPlanInputs }
  | { ok: false; error: ExtraAgentArgsError }

type Tokenized = { tokens: string[]; spans: { start: number; end: number }[] }

function tokenize(value: string, shell: AgentStartupShell): Tokenized | null {
  if (!value) {
    return { tokens: [], spans: [] }
  }
  const result = tokenizeStartupCommand(value, shell)
  return result.ok ? result : null
}

function refuse(error: ExtraAgentArgsError): AppliedExtraAgentArgs {
  return { ok: false, error }
}

// Command overrides run verbatim, so a typed flag cannot replace one there.
function checkOverride(
  inputs: AgentStartupPlanInputs,
  shell: AgentStartupShell,
  conflicting: readonly ExtraArgsFamily[]
): ExtraAgentArgsError | null {
  const override = inputs.cmdOverrides[inputs.agent]
  if (!override || conflicting.length === 0) {
    return null
  }
  const agent = TUI_AGENT_DISPLAY_NAMES[inputs.agent]
  const tokens = tokenize(override.trim(), shell)
  if (!tokens) {
    return extraAgentArgsError('override-unclosed-quote', 'override', { agent })
  }
  const family = conflicting.find((candidate) => extraArgsFamilyIsPresent(candidate, tokens.tokens))
  return family
    ? extraAgentArgsError('override-sets-option', 'override', { agent, option: family.label })
    : null
}

/** Rebuilds from source text because re-quoted tokens don't round-trip through the tokenizer. */
function rebuild(
  agent: TuiAgent,
  base: string,
  baseTokens: Tokenized,
  kept: readonly string[],
  extras: string,
  extraTokens: readonly string[]
): { text: string; tokens: string[] } | null {
  const keptIndexes: number[] = []
  let cursor = 0
  for (const token of kept) {
    while (cursor < baseTokens.tokens.length && baseTokens.tokens[cursor] !== token) {
      cursor += 1
    }
    if (cursor === baseTokens.tokens.length) {
      return null
    }
    keptIndexes.push(cursor)
    cursor += 1
  }
  const terminator = agentArgTerminatorIndex(agent, baseTokens.tokens)
  const before = keptIndexes.filter((index) => index < terminator)
  const after = keptIndexes.filter((index) => index >= terminator)
  const text = (indexes: number[]) =>
    indexes.map((index) => base.slice(baseTokens.spans[index].start, baseTokens.spans[index].end))
  return {
    text: [...text(before), extras, ...text(after)].join(' '),
    tokens: [
      ...before.map((index) => baseTokens.tokens[index]),
      ...extraTokens,
      ...after.map((index) => baseTokens.tokens[index])
    ]
  }
}

/** Adds one launch's typed arguments to resolved inputs. */
export function applyExtraAgentArgs(
  inputs: AgentStartupPlanInputs,
  extraArgs: string,
  launch: { promptOnCommandLine: boolean }
): AppliedExtraAgentArgs {
  const extras = extraArgs.trim()
  if (!extras) {
    return { ok: true, inputs }
  }
  // Why: extras alone over the cap can't fit the merged string; refuse before scanning them.
  if (new TextEncoder().encode(extras).byteLength > MAX_AGENT_ARGS_BYTES) {
    return refuse(extraAgentArgsError('too-large', 'extras'))
  }
  const { agent } = inputs
  const shell = resolveStartupShell(inputs.platform, inputs.shell)
  const placement = checkPromptPlacement(agent, launch.promptOnCommandLine)
  if (placement) {
    return refuse(placement)
  }
  const extraTokens = tokenize(extras, shell)
  if (!extraTokens) {
    return refuse(extraAgentArgsError('extras-unclosed-quote', 'extras'))
  }
  const shapeError = checkExtraTokenShape(agent, extraTokens.tokens)
  if (shapeError) {
    return refuse(shapeError)
  }
  const base = inputs.agentArgs?.trim() ?? ''
  const baseTokens = tokenize(base, shell)
  if (!baseTokens) {
    return refuse(
      extraAgentArgsError('defaults-unclosed-quote', 'defaults', {
        agent: TUI_AGENT_DISPLAY_NAMES[agent]
      })
    )
  }
  const tokenError =
    checkOrcaOwnedFlags(agent, extraTokens.tokens, launch.promptOnCommandLine) ??
    checkWindowsTokens(extraTokens.tokens, shell, 'extras')
  if (tokenError) {
    return refuse(tokenError)
  }
  const bypassFlags = getAgentBypassFlags(agent, shell)
  const bypassInBoth = bypassFlags.find(
    (flag) =>
      hasAgentExtraArgsFlag(agent, extraTokens.tokens, [flag]) &&
      hasAgentExtraArgsFlag(agent, baseTokens.tokens, [flag])
  )
  if (bypassInBoth) {
    // Why: removing it gives the permissions toggle a second owner; passing it repeats it.
    return refuse(
      extraAgentArgsError('defaults-set-flag', 'extras', {
        agent: TUI_AGENT_DISPLAY_NAMES[agent],
        flag: bypassInBoth
      })
    )
  }
  const typed = getExtraArgsFamilies(agent, bypassFlags).filter((family) =>
    extraArgsFamilyIsPresent(family, extraTokens.tokens)
  )
  const repeated = findRepeatedFamily(typed, extraTokens.tokens)
  if (repeated) {
    return refuse(extraAgentArgsError('repeated-option', 'extras', { option: repeated.label }))
  }
  const overrideError = checkOverride(inputs, shell, typed)
  if (overrideError) {
    return refuse(overrideError)
  }
  let kept: readonly string[] = baseTokens.tokens
  for (const family of typed) {
    kept = family.remove(kept)
  }
  const defaultsError = checkWindowsTokens(kept, shell, 'defaults')
  if (defaultsError) {
    return refuse(defaultsError)
  }
  const rebuilt = rebuild(agent, base, baseTokens, kept, extras, extraTokens.tokens)
  const merged = rebuilt?.text.trim() ?? ''
  const verified = tokenize(merged, shell)
  // Why: the launch trims before tokenizing; a join can turn a trailing escape into a new token.
  if (
    !rebuilt ||
    !verified ||
    verified.tokens.length !== rebuilt.tokens.length ||
    verified.tokens.some((token, index) => token !== rebuilt.tokens[index])
  ) {
    return refuse(extraAgentArgsError('rebuild-failed', 'extras'))
  }
  if (new TextEncoder().encode(merged).byteLength > MAX_AGENT_ARGS_BYTES) {
    return refuse(extraAgentArgsError('too-large', 'extras'))
  }
  const mergedInputs: AgentStartupPlanInputs = { ...inputs, agentArgs: merged }
  if (inputs.sessionOptions && inputs.sessionOptionsOverrideAgentArgs) {
    // Why: otherwise the launch removes the typed flag as one the pick covers.
    const applied = resolveAgentSessionOptionLaunch(
      agent,
      inputs.sessionOptions,
      extraTokens.tokens,
      false
    ).appliedValues
    mergedInputs.sessionOptions = Object.keys(applied).length > 0 ? applied : undefined
  }
  const ompError = agent === 'omp' ? checkOmpFreshSession(inputs, mergedInputs, shell) : null
  if (ompError) {
    return refuse(ompError)
  }
  return { ok: true, inputs: mergedInputs }
}

// An unsupported argument disables OMP's fresh-session wrapper and may resume the last session.
function checkOmpFreshSession(
  before: AgentStartupPlanInputs,
  after: AgentStartupPlanInputs,
  shell: AgentStartupShell
): ExtraAgentArgsError | null {
  const command = (inputs: AgentStartupPlanInputs) => {
    const resolved = resolveAgentLaunchCommand({ ...inputs, shell })
    return resolved.ok ? resolved.command : null
  }
  const beforeCommand = command(before)
  const afterCommand = command(after)
  if (!beforeCommand || !afterCommand || findFreshOmpLaunchBlocker(beforeCommand, shell) !== null) {
    return null
  }
  const blocker = findFreshOmpLaunchBlocker(afterCommand, shell)
  return blocker === null
    ? null
    : extraAgentArgsError('omp-fresh-session', 'extras', { token: blocker })
}
