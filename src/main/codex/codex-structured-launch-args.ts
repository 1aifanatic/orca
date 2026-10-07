// Saved Arguments are written for the interactive `codex` a terminal runs; a chat runs
// `codex app-server`, which reads only config and its own few options. So each interactive option
// either passes to app-server, becomes the config Codex itself derives from it, is dropped because
// it only shapes a terminal, or refuses the start by name because a chat can't honor it.
import { StructuredAgentArgumentsError } from '../native-chat/structured-agent-arguments-error'
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  type CodexStructuredPermissionPolicy
} from './codex-structured-permission-policy'

export type CodexStructuredLaunchArgs = {
  /** Options for after `app-server`. */
  args: string[]
  /** The sandbox and approval policy the Arguments state explicitly. */
  permissions: Partial<CodexStructuredPermissionPolicy>
}

type LaunchPlan = {
  args: string[]
  /** Config the interactive CLI derives from its own options; it applies them after every `-c`. */
  derived: string[]
  /** From `-c`, last one wins. */
  configured: Partial<CodexStructuredPermissionPolicy>
  /** From `-s` / `-a`, which outrank config. */
  flags: Partial<CodexStructuredPermissionPolicy>
}

type OptionRule =
  | { takesValue: boolean; apply?: (plan: LaunchPlan, option: string, value: string) => void }
  | 'refuse'

const pass = (plan: LaunchPlan, option: string, value: string): void => {
  plan.args.push(option, ...(value ? [value] : []))
}

const passConfig = (plan: LaunchPlan, option: string, value: string): void => {
  readConfiguredPermission(plan.configured, option, value)
  pass(plan, option, value)
}

const derive =
  (...overrides: string[]) =>
  (plan: LaunchPlan): void => {
    plan.derived.push(...overrides)
  }

const deriveModel = (plan: LaunchPlan, _option: string, value: string): void => {
  // A JSON string is a valid TOML basic string.
  plan.derived.push(`model=${JSON.stringify(value)}`)
}

const flagSandbox = (plan: LaunchPlan, option: string, value: string): void => {
  plan.flags.sandbox = oneOf(CODEX_SANDBOX_MODES, value, option)
}

const flagApproval = (plan: LaunchPlan, option: string, value: string): void => {
  plan.flags.approvalPolicy = oneOf(CODEX_APPROVAL_POLICIES, value, option)
}

const VALUE = { takesValue: true }
const DROPPED_SWITCH = { takesValue: false }
const APPROVE_FOR_ME = {
  takesValue: false,
  apply: derive(
    'approvals_reviewer="auto_review"',
    'approval_policy="on-request"',
    'sandbox_mode="workspace-write"'
  )
}

// Equivalents are the ones Codex applies itself: `--search` and `--approve-for-me` in
// codex-rs cli/src/main.rs and utils/cli/src/shared_options.rs, `-m` as `-c model=`.
const RULES: Record<string, OptionRule> = {
  '-c': { ...VALUE, apply: passConfig },
  '--config': { ...VALUE, apply: passConfig },
  '--enable': { ...VALUE, apply: pass },
  '--disable': { ...VALUE, apply: pass },
  '--strict-config': { takesValue: false, apply: pass },
  '-m': { ...VALUE, apply: deriveModel },
  '--model': { ...VALUE, apply: deriveModel },
  '--search': { takesValue: false, apply: derive('web_search="live"') },
  '-s': { ...VALUE, apply: flagSandbox },
  '--sandbox': { ...VALUE, apply: flagSandbox },
  '-a': { ...VALUE, apply: flagApproval },
  '--ask-for-approval': { ...VALUE, apply: flagApproval },
  '--approve-for-me': APPROVE_FOR_ME,
  '--not-so-yolo': APPROVE_FOR_ME,
  // Agent Permissions reads the bypass flag; the rest only shape a terminal.
  '--dangerously-bypass-approvals-and-sandbox': DROPPED_SWITCH,
  '--yolo': DROPPED_SWITCH,
  '--no-alt-screen': DROPPED_SWITCH,
  '--no-daemon': DROPPED_SWITCH,
  '--help': DROPPED_SWITCH,
  '-h': DROPPED_SWITCH,
  '--version': DROPPED_SWITCH,
  '-V': DROPPED_SWITCH,
  // No app-server equivalent: a different config, provider, server, folder or first prompt.
  '-p': 'refuse',
  '--profile': 'refuse',
  '--oss': 'refuse',
  '--local-provider': 'refuse',
  '--remote': 'refuse',
  '--remote-auth-token-env': 'refuse',
  '--add-dir': 'refuse',
  '-C': 'refuse',
  '--cd': 'refuse',
  '-i': 'refuse',
  '--image': 'refuse',
  '--worktree': 'refuse',
  '--dangerously-bypass-hook-trust': 'refuse'
}

function oneOf<T extends string>(values: readonly T[], value: string, option: string): T {
  const match = values.find((candidate) => candidate === value)
  if (match === undefined) {
    throw new StructuredAgentArgumentsError('Codex', option, 'invalidValue')
  }
  return match
}

/** The policy a `-c approval_policy=` / `sandbox_mode=` sets, read the way Codex reads it. */
function readConfiguredPermission(
  configured: Partial<CodexStructuredPermissionPolicy>,
  option: string,
  override: string
): void {
  const separator = override.indexOf('=')
  if (separator === -1) {
    return
  }
  const key = override.slice(0, separator).trim()
  // Codex takes a value that isn't TOML as its text with the quotes trimmed.
  const value = override
    .slice(separator + 1)
    .trim()
    .replace(/^["']+|["']+$/g, '')
  if (key === 'approval_policy') {
    configured.approvalPolicy = oneOf(CODEX_APPROVAL_POLICIES, value, option)
  } else if (key === 'sandbox_mode') {
    configured.sandbox = oneOf(CODEX_SANDBOX_MODES, value, option)
  }
}

function optionName(token: string): string {
  if (token.startsWith('--')) {
    return token.split('=', 1)[0]
  }
  return /^-[acmspiC].+/.test(token) ? token.slice(0, 2) : token
}

// Codex's parser accepts `-c=k=v` as well as `-ck=v`.
function inlineValue(token: string, option: string): string | undefined {
  if (token === option) {
    return undefined
  }
  return token.startsWith('--') ? token.slice(option.length + 1) : token.slice(2).replace(/^=/, '')
}

/** Turns saved terminal Arguments into a structured app-server launch. */
export function codexStructuredLaunchArgs(tokens: readonly string[]): CodexStructuredLaunchArgs {
  const plan: LaunchPlan = { args: [], derived: [], configured: {}, flags: {} }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      // What follows is the terminal's first prompt.
      if (index + 1 < tokens.length) {
        throw new StructuredAgentArgumentsError('Codex', token, 'positionalPrompt')
      }
      break
    }
    if (!token.startsWith('-')) {
      throw new StructuredAgentArgumentsError('Codex', token, 'positionalPrompt')
    }
    const option = optionName(token)
    const rule = RULES[option]
    if (!rule || rule === 'refuse') {
      throw new StructuredAgentArgumentsError('Codex', option, 'unsupportedOption')
    }
    let value = ''
    if (rule.takesValue) {
      const inline = inlineValue(token, option)
      value = inline ?? tokens[++index] ?? ''
      if (!value || value === '--' || (value.startsWith('-') && inline === undefined)) {
        throw new StructuredAgentArgumentsError('Codex', option, 'missingValue')
      }
    } else if (token !== option) {
      throw new StructuredAgentArgumentsError('Codex', option, 'unsupportedOption')
    }
    rule.apply?.(plan, option, value)
  }
  for (const override of plan.derived) {
    passConfig(plan, '-c', override)
  }
  return { args: plan.args, permissions: { ...plan.configured, ...plan.flags } }
}
