// Saved Arguments are written for the interactive `codex` a terminal runs; a chat runs
// `codex app-server`, which reads only config and its own few options. So each interactive option
// either passes to app-server, becomes the config Codex itself derives from it, is dropped because
// it sets permissions (Agent Permissions owns those) or only shapes a terminal, or refuses the
// start by name because a chat can't honor it.
import { parseTomlKeyPath } from './config-toml-key-path'
import { StructuredAgentArgumentsError } from '../native-chat/structured-agent-arguments-error'

type LaunchPlan = {
  args: string[]
  /** Config the interactive CLI derives from its own options; it applies them after every `-c`. */
  derived: string[]
}

type OptionRule =
  | { takesValue: boolean; apply?: (plan: LaunchPlan, option: string, value: string) => void }
  | 'refuse'

const pass = (plan: LaunchPlan, option: string, value: string): void => {
  plan.args.push(option, ...(value ? [value] : []))
}

// The permission options' own config keys, dropped with them.
const passConfig = (plan: LaunchPlan, option: string, value: string): void => {
  const key = parseTomlKeyPath(value)?.segments[0]
  if (
    key !== 'approval_policy' &&
    key !== 'sandbox_mode' &&
    key !== 'approvals_reviewer' &&
    key !== 'sandbox_workspace_write'
  ) {
    pass(plan, option, value)
  }
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

const VALUE = { takesValue: true }
const DROPPED_SWITCH = { takesValue: false }

// Equivalents are the ones Codex applies itself: `--search` in codex-rs cli/src/main.rs, `-m` as
// `-c model=`.
const RULES: Record<string, OptionRule> = {
  '-c': { ...VALUE, apply: passConfig },
  '--config': { ...VALUE, apply: passConfig },
  '--enable': { ...VALUE, apply: pass },
  '--disable': { ...VALUE, apply: pass },
  '--strict-config': { takesValue: false, apply: pass },
  '-m': { ...VALUE, apply: deriveModel },
  '--model': { ...VALUE, apply: deriveModel },
  '--search': { takesValue: false, apply: derive('web_search="live"') },
  // Permissions come from Agent Permissions alone; the rest only shape a terminal.
  '-s': VALUE,
  '--sandbox': VALUE,
  '-a': VALUE,
  '--ask-for-approval': VALUE,
  '--approve-for-me': DROPPED_SWITCH,
  '--not-so-yolo': DROPPED_SWITCH,
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

/** Turns saved terminal Arguments into options for after `app-server`. */
export function codexStructuredLaunchArgs(tokens: readonly string[]): string[] {
  const plan: LaunchPlan = { args: [], derived: [] }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      // What follows is the terminal's first prompt.
      if (index + 1 < tokens.length) {
        throw new StructuredAgentArgumentsError('Codex', token, 'positionalPrompt')
      }
      break
    }
    if (!token.startsWith('-') || token === '-') {
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
    pass(plan, '-c', override)
  }
  return plan.args
}
