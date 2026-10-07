// Saved Arguments are written for the interactive `claude` a terminal runs. A chat forwards every
// option as typed after the SDK's own flags (so repeats, several values and dash-leading values
// reach the CLI intact), except what the chat owns: the stream protocol, the session's identity
// and its permissions are dropped, and an option that would move the session elsewhere refuses
// the start by name.
import { StructuredAgentArgumentsError } from '../native-chat/structured-agent-arguments-error'
import { CLAUDE_CLI_OPTIONS, CLAUDE_CLI_SHORT_OPTIONS } from '../../shared/claude-cli-options'

/** An option as typed, with its values, under its canonical long name. */
export type ClaudeConfiguredArg = { option: string; tokens: string[] }

type Action = 'pass' | 'drop' | 'refuse'

// The chat's permission mode is Agent Permissions', never one typed into Arguments. Tool allow
// and deny rules are forwarded; each is one switch.
const PERMISSION_MODE: Action = 'drop'
const TOOL_RULES: Action = 'pass'

/** What a chat does with an option other than pass it on. */
const ACTIONS: Readonly<Record<string, Action>> = {
  '--permission-mode': PERMISSION_MODE,
  '--inherit-permission-mode': PERMISSION_MODE,
  '--allowedTools': TOOL_RULES,
  '--allowed-tools': TOOL_RULES,
  '--disallowedTools': TOOL_RULES,
  '--disallowed-tools': TOOL_RULES,
  // Agent Permissions reads the bypass flag; the rest are the stream protocol or the session's
  // identity, which the chat owns.
  '--dangerously-skip-permissions': 'drop',
  '--allow-dangerously-skip-permissions': 'drop',
  '--print': 'drop',
  '--input-format': 'drop',
  '--output-format': 'drop',
  '--json-schema': 'drop',
  '--verbose': 'drop',
  '--include-partial-messages': 'drop',
  '--include-hook-events': 'drop',
  '--forward-subagent-text': 'drop',
  '--replay-user-messages': 'drop',
  '--permission-prompt-tool': 'drop',
  '--permission-prompts': 'drop',
  '--continue': 'drop',
  '--resume': 'drop',
  '--from-pr': 'drop',
  '--session-id': 'drop',
  '--fork-session': 'drop',
  '--resume-session-at': 'drop',
  '--resume-drops-turn': 'drop',
  '--no-session-persistence': 'drop',
  '--session-mirror': 'drop',
  '--await-initialize': 'drop',
  '--help': 'drop',
  '--version': 'drop',
  // These run the session somewhere other than the chat's own folder and process.
  '--worktree': 'refuse',
  '--tmux': 'refuse',
  '--bg': 'refuse',
  '--background': 'refuse',
  '--cloud': 'refuse',
  '--teleport': 'refuse',
  '--remote': 'refuse',
  '--remote-control': 'refuse',
  '--rc': 'refuse',
  '--environment': 'refuse',
  '--pool': 'refuse'
}

/** The CLI parser's test for a token that can't be an optional or further variadic value. */
function looksLikeOption(token: string): boolean {
  return token.length > 1 && token.startsWith('-')
}

/** Saved Arguments as the options a chat forwards to the Claude CLI, in order. */
export function claudeStructuredLaunchArgs(args: readonly string[]): ClaudeConfiguredArg[] {
  const forwarded: ClaudeConfiguredArg[] = []
  const queue = [...args]
  for (let token = queue.shift(); token !== undefined; token = queue.shift()) {
    if (token === '--') {
      // What follows is the terminal's first prompt.
      if (queue.length > 0) {
        throw new StructuredAgentArgumentsError('Claude', token, 'positionalPrompt')
      }
      break
    }
    if (!looksLikeOption(token)) {
      throw new StructuredAgentArgumentsError('Claude', token, 'positionalPrompt')
    }
    let typed = token
    let option = token
    let inline: string | undefined
    if (token.startsWith('--')) {
      const separator = token.indexOf('=')
      option = separator === -1 ? token : token.slice(0, separator)
      inline = separator === -1 ? undefined : token.slice(separator + 1)
    } else if (token.length > 2 && !CLAUDE_CLI_SHORT_OPTIONS[token]) {
      // `-nNAME` is a short option's value; `-pc` is two switches, as the CLI parser reads them.
      const short = CLAUDE_CLI_SHORT_OPTIONS[token.slice(0, 2)]
      if (short && CLAUDE_CLI_OPTIONS[short] === 'switch') {
        queue.unshift(`-${token.slice(2)}`)
        typed = token.slice(0, 2)
      } else if (short) {
        inline = token.slice(2)
      }
      option = token.slice(0, 2)
    }
    const name = CLAUDE_CLI_SHORT_OPTIONS[option] ?? option
    const arity = CLAUDE_CLI_OPTIONS[name]
    const action = ACTIONS[name] ?? 'pass'
    const tokens = [typed]
    if (inline === undefined) {
      if (arity === 'value' || arity === 'variadic') {
        // A required value is the next token, even one that starts with `-`.
        const value = queue.shift()
        if (value === undefined) {
          throw new StructuredAgentArgumentsError('Claude', option, 'missingValue')
        }
        tokens.push(value)
      }
      if (arity === 'optional' && queue[0] !== undefined && !looksLikeOption(queue[0])) {
        tokens.push(queue.shift()!)
      }
      // An unknown option's arity is the CLI's to judge, so its bare words go with it as typed.
      if (!arity || arity === 'variadic') {
        while (queue[0] !== undefined && !looksLikeOption(queue[0])) {
          tokens.push(queue.shift()!)
        }
      }
    }
    if (action === 'refuse') {
      throw new StructuredAgentArgumentsError('Claude', option, 'unsupportedOption')
    }
    if (action !== 'drop') {
      // An unknown option is forwarded too: the CLI is the authority on its own options, and one
      // it rejects is named by `claudeSavedOptionRejection`.
      forwarded.push({ option: name, tokens })
    }
  }
  return forwarded
}

// The CLI parser's refusal, exactly; claude-thinking-display-support.ts relies on the same text.
const UNKNOWN_OPTION = /unknown option '([^']+)'/

/** A start the CLI refused over an option saved in Arguments, as the refusal that names it. */
export function claudeSavedOptionRejection(
  error: Error,
  configuredArgs: readonly ClaudeConfiguredArg[]
): Error {
  const rejected = UNKNOWN_OPTION.exec(error.message)?.[1]?.split('=', 1)[0]
  const saved = configuredArgs.find(
    (arg) => arg.option === rejected || arg.tokens[0]?.split('=', 1)[0] === rejected
  )
  return saved
    ? new StructuredAgentArgumentsError('Claude', saved.option, 'unsupportedOption', error)
    : error
}
