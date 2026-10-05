import { hasFlag } from './agent-cli-flag-detection'
import {
  classifyExtraArgs,
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
  getAgentBypassFlags
} from './agent-extra-args-token-checks'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import type { AgentStartupPlanInputs } from './agent-startup-plan-inputs'
import { findFreshOmpLaunchBlocker } from './omp-fresh-launch'
import { MAX_AGENT_ARGS_BYTES } from './rpc-contract/agent-session-params'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import {
  resolveStartupShell,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

export type ExtraAgentArgsKind = 'catalog_only' | 'other'

export type AppliedExtraAgentArgs =
  | { ok: true; inputs: AgentStartupPlanInputs; extraKind: ExtraAgentArgsKind | null }
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

/** Step 3: the override is typed as written, so a flag it already sets can't be replaced. */
function checkOverride(
  inputs: AgentStartupPlanInputs,
  shell: AgentStartupShell,
  conflicting: readonly ExtraArgsFamily[]
): ExtraAgentArgsError | null {
  const override = inputs.cmdOverrides[inputs.agent]
  // Why: overrides are typed as written, so an untokenizable one only matters to this check.
  if (!override || conflicting.length === 0) {
    return null
  }
  const agent = TUI_AGENT_DISPLAY_NAMES[inputs.agent]
  const tokens = tokenize(override.trim(), shell)
  if (!tokens) {
    return extraAgentArgsError('override-unclosed-quote', 'override', { agent })
  }
  const family = conflicting.find((candidate) => candidate.detect(tokens.tokens))
  return family
    ? extraAgentArgsError('override-sets-option', 'override', { agent, option: family.label })
    : null
}

/** Rebuilds from source text because re-quoted tokens don't round-trip through the tokenizer. */
function rebuild(
  base: string,
  baseTokens: Tokenized,
  kept: readonly string[],
  extras: string
): { text: string; expected: (extraTokens: readonly string[]) => string[] } | null {
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
  const terminator = baseTokens.tokens.indexOf('--')
  const before = keptIndexes.filter((index) => terminator === -1 || index < terminator)
  const after = keptIndexes.filter((index) => terminator !== -1 && index >= terminator)
  const text = (indexes: number[]) =>
    indexes.map((index) => base.slice(baseTokens.spans[index].start, baseTokens.spans[index].end))
  return {
    text: [...text(before), extras, ...text(after)].join(' '),
    expected: (extraTokens) => [
      ...before.map((index) => baseTokens.tokens[index]),
      ...extraTokens,
      ...after.map((index) => baseTokens.tokens[index])
    ]
  }
}

/** Adds one launch's typed arguments to resolved inputs; see docs/design/per-launch-agent-args. */
export function applyExtraAgentArgs(
  inputs: AgentStartupPlanInputs,
  extraArgs: string,
  launch: { promptOnCommandLine: boolean }
): AppliedExtraAgentArgs {
  const extras = extraArgs.trim()
  if (!extras) {
    return { ok: true, inputs, extraKind: null }
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
  const shapeError = checkExtraTokenShape(extraTokens.tokens)
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
    checkWindowsTokens(extraTokens.tokens, shell, 'extras') ??
    checkWindowsTokens(baseTokens.tokens, shell, 'defaults')
  if (tokenError) {
    return refuse(tokenError)
  }
  const bypassFlags = getAgentBypassFlags(agent, shell)
  const bypassInBoth = bypassFlags.find(
    (flag) => hasFlag(extraTokens.tokens, [flag]) && hasFlag(baseTokens.tokens, [flag])
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
    family.detect(extraTokens.tokens)
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
    if (family.remove) {
      kept = family.remove(kept)
    }
  }
  // Why: a typed flag the defaults still set after every remover ran would reach the agent twice.
  const unremovable = typed.find((family) => family.detect(kept))
  if (unremovable) {
    return refuse(
      extraAgentArgsError('defaults-set-flag', 'extras', {
        agent: TUI_AGENT_DISPLAY_NAMES[agent],
        flag: unremovable.label
      })
    )
  }
  const rebuilt = rebuild(base, baseTokens, kept, extras)
  const merged = rebuilt?.text.trim() ?? ''
  const verified = tokenize(merged, shell)
  // Why: the launch trims before tokenizing; a join can turn a trailing escape into a new token.
  if (
    !rebuilt ||
    !verified ||
    JSON.stringify(verified.tokens) !== JSON.stringify(rebuilt.expected(extraTokens.tokens))
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
  return { ok: true, inputs: mergedInputs, extraKind: classifyExtraArgs(agent, extraTokens.tokens) }
}

/** Step 8: the fresh-session wrapper falls back to a bare command, which may resume OMP's last
 *  session, for any argument outside its list. */
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
    : extraAgentArgsError('omp-fresh-session', 'extras', { token: blocker || afterCommand })
}
