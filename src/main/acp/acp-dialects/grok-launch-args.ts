// Saved Arguments are written for the interactive `grok` a terminal runs; a chat runs
// `grok [root options] agent [agent options] stdio`, and `agent` reads only a few root options. So
// each option either stays before `agent`, moves to the `agent` option it has there, is dropped
// because it sets permissions, belongs to a terminal or to the session Orca owns, or refuses the
// start by name because a chat can't honor it.
import { StructuredAgentArgumentsError } from '../../native-chat/structured-agent-arguments-error'

type LaunchPlan = { root: string[]; agent: string[]; models: number }

type OptionRule =
  | { takesValue: boolean; apply?: (plan: LaunchPlan, option: string, value: string) => void }
  | 'refuse'

const root = (plan: LaunchPlan, option: string, value: string): void => {
  plan.root.push(option, ...(value ? [value] : []))
}

const agentOption =
  (name: string) =>
  (plan: LaunchPlan, _option: string, value: string): void => {
    plan.agent.push(name, ...(value ? [value] : []))
  }

const model = (plan: LaunchPlan, option: string, value: string): void => {
  // `agent --model` takes one value; a second is the parser's error in a terminal too.
  if (++plan.models > 1) {
    throw new StructuredAgentArgumentsError('Grok', option, 'multipleValues')
  }
  agentOption('--model')(plan, option, value)
}

const VALUE = { takesValue: true }
const SWITCH = { takesValue: false }
const ROOT_VALUE = { takesValue: true, apply: root }
const ROOT_SWITCH = { takesValue: false, apply: root }
const EFFORT = { takesValue: true, apply: agentOption('--reasoning-effort') }

// From grok's own parser (xai-grok-pager src/app/cli.rs); `grok agent` honors only the root
// options kept here (xai-grok-pager-bin src/main.rs run_agent_command).
const RULES: Record<string, OptionRule> = {
  '--debug': ROOT_SWITCH,
  '--debug-file': ROOT_VALUE,
  '--leader-socket': ROOT_VALUE,
  '--disable-web-search': ROOT_SWITCH,
  '--no-auto-update': ROOT_SWITCH,
  '-m': { ...VALUE, apply: model },
  '--model': { ...VALUE, apply: model },
  '--effort': EFFORT,
  '--reasoning-effort': EFFORT,
  // A root `--no-leader` is an error beside `agent`; the agent takes its own.
  '--no-leader': { takesValue: false, apply: agentOption('--no-leader') },
  // Agent Permissions sets the chat's permissions.
  '--permission-mode': VALUE,
  '--always-approve': SWITCH,
  '--yolo': SWITCH,
  '--dangerously-skip-permissions': SWITCH,
  '--allow': VALUE,
  '--allowedTools': VALUE,
  '--deny': VALUE,
  '--disallowedTools': VALUE,
  '--sandbox': VALUE,
  '--trust': SWITCH,
  '--trust-folder': SWITCH,
  // Only shape a terminal.
  '--no-alt-screen': SWITCH,
  '--minimal': SWITCH,
  '--fullscreen': SWITCH,
  '-h': SWITCH,
  '--help': SWITCH,
  '-v': SWITCH,
  '-V': SWITCH,
  '--version': SWITCH,
  // The session and its output are the chat's own.
  '-r': { takesValue: false },
  '--resume': { takesValue: false },
  '--load': VALUE,
  '-c': SWITCH,
  '--continue': SWITCH,
  '-s': VALUE,
  '--session-id': VALUE,
  '--fork-session': SWITCH,
  '--restore-code': SWITCH,
  '-p': VALUE,
  '--single': VALUE,
  '--print': VALUE,
  '--prompt-json': VALUE,
  '--prompt-file': VALUE,
  '--output-format': VALUE,
  '--include-partial-messages': SWITCH,
  '--json-schema': VALUE,
  '--verbatim': SWITCH,
  // No chat equivalent: another folder, a shared process, or another prompt or tool set.
  '--cwd': 'refuse',
  '-w': 'refuse',
  '--worktree': 'refuse',
  '--worktree-ref': 'refuse',
  '--ref': 'refuse',
  '--leader': 'refuse',
  '--rules': 'refuse',
  '--append-system-prompt': 'refuse',
  '--system-prompt': 'refuse',
  '--system-prompt-override': 'refuse',
  '--tools': 'refuse'
}

/** Takes an optional value, as `--resume [SESSION]` does: only a next token that isn't an option. */
const OPTIONAL_VALUE = new Set(['-r', '--resume'])

function optionName(token: string): string {
  if (token.startsWith('--')) {
    return token.split('=', 1)[0]
  }
  return /^-[mspr].+/.test(token) ? token.slice(0, 2) : token
}

// Grok's parser accepts `-m=X` as well as `-mX`.
function inlineValue(token: string, option: string): string | undefined {
  if (token === option) {
    return undefined
  }
  return token.startsWith('--') ? token.slice(option.length + 1) : token.slice(2).replace(/^=/, '')
}

/** Saved terminal Arguments as `grok` argv: what goes before `agent`, and the `agent` options. */
function grokLaunchArgs(tokens: readonly string[]): { root: string[]; agent: string[] } {
  const plan: LaunchPlan = { root: [], agent: [], models: 0 }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      // What follows is the terminal's first prompt.
      if (index + 1 < tokens.length) {
        throw new StructuredAgentArgumentsError('Grok', token, 'positionalPrompt')
      }
      break
    }
    if (!token.startsWith('-') || token === '-') {
      throw new StructuredAgentArgumentsError('Grok', token, 'positionalPrompt')
    }
    const option = optionName(token)
    const rule = RULES[option]
    if (!rule || rule === 'refuse') {
      throw new StructuredAgentArgumentsError('Grok', option, 'unsupportedOption')
    }
    let value = ''
    if (rule.takesValue) {
      const inline = inlineValue(token, option)
      value = inline ?? tokens[++index] ?? ''
      if (!value || value === '--' || (value.startsWith('-') && inline === undefined)) {
        throw new StructuredAgentArgumentsError('Grok', option, 'missingValue')
      }
    } else if (OPTIONAL_VALUE.has(option)) {
      if (
        token === option &&
        tokens[index + 1] !== undefined &&
        !tokens[index + 1].startsWith('-')
      ) {
        index += 1
      }
    } else if (token !== option) {
      throw new StructuredAgentArgumentsError('Grok', option, 'unsupportedOption')
    }
    rule.apply?.(plan, option, value)
  }
  return { root: plan.root, agent: plan.agent }
}

/** `grok [root] agent [agent] stdio` for a chat: the saved Arguments placed where `grok agent`
 *  reads them, and full access as the agent's own flag. */
export function grokAgentArgv(input: {
  fullAccess: boolean
  configured: readonly string[]
}): string[] {
  const { root, agent } = grokLaunchArgs(input.configured)
  return [...root, 'agent', ...agent, ...(input.fullAccess ? ['--always-approve'] : []), 'stdio']
}
