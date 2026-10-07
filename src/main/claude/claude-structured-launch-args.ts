// Saved Arguments are written for the interactive `claude` a terminal runs. A chat forwards every
// option as typed after the SDK's own flags (so repeats, several values and dash-leading values
// reach the CLI intact), except what the chat owns: the stream protocol, the session's identity
// and its permissions are dropped, and an option that would move the session elsewhere refuses
// the start by name.
import { StructuredAgentArgumentsError } from '../native-chat/structured-agent-arguments-error'

/** An option as typed, with its values, under its canonical long name. */
export type ClaudeConfiguredArg = { option: string; tokens: string[] }

/** How the CLI's option parser takes values: `<v>`, `[v]` or `<v...>`. */
type Arity = 'switch' | 'value' | 'optional' | 'variadic'
type Action = 'pass' | 'drop' | 'refuse'
type OptionRule = { arity: Arity; action: Action }

// Pending product decision: what saved permission options do in a chat.
const PERMISSION_MODE: Action = 'drop'
const TOOL_RULES: Action = 'pass'

const rule = (arity: Arity, action: Action = 'pass'): OptionRule => ({ arity, action })

// From the CLI's own option table (claude 2.1.280). Options it doesn't list are forwarded as typed.
const RULES: Record<string, OptionRule> = {
  '--add-dir': rule('variadic'),
  '--agent': rule('value'),
  '--agents': rule('value'),
  '--allowedTools': rule('variadic', TOOL_RULES),
  '--allowed-tools': rule('variadic', TOOL_RULES),
  '--disallowedTools': rule('variadic', TOOL_RULES),
  '--disallowed-tools': rule('variadic', TOOL_RULES),
  '--append-system-prompt': rule('value'),
  '--append-system-prompt-file': rule('value'),
  '--system-prompt': rule('value'),
  '--system-prompt-file': rule('value'),
  '--bare': rule('switch'),
  '--betas': rule('variadic'),
  '--chrome': rule('switch'),
  '--no-chrome': rule('switch'),
  '--debug': rule('optional'),
  '--debug-file': rule('value'),
  '--disable-slash-commands': rule('switch'),
  '--effort': rule('value'),
  '--fallback-model': rule('value'),
  '--file': rule('variadic'),
  '--ide': rule('switch'),
  '--max-budget-usd': rule('value'),
  '--max-thinking-tokens': rule('value'),
  '--mcp-config': rule('variadic'),
  '--model': rule('value'),
  '--name': rule('value'),
  '--plugin-dir': rule('value'),
  '--plugin-url': rule('value'),
  '--setting-sources': rule('value'),
  '--settings': rule('value'),
  '--strict-mcp-config': rule('switch'),
  '--thinking': rule('value'),
  '--thinking-display': rule('value'),
  '--tools': rule('variadic'),
  '--permission-mode': rule('value', PERMISSION_MODE),
  // Agent Permissions reads the bypass flag; the rest are the stream protocol or the session's
  // identity, which the chat owns.
  '--dangerously-skip-permissions': rule('switch', 'drop'),
  '--allow-dangerously-skip-permissions': rule('switch', 'drop'),
  '--print': rule('switch', 'drop'),
  '--input-format': rule('value', 'drop'),
  '--output-format': rule('value', 'drop'),
  '--json-schema': rule('value', 'drop'),
  '--verbose': rule('switch', 'drop'),
  '--include-partial-messages': rule('switch', 'drop'),
  '--include-hook-events': rule('switch', 'drop'),
  '--forward-subagent-text': rule('switch', 'drop'),
  '--replay-user-messages': rule('switch', 'drop'),
  '--permission-prompt-tool': rule('value', 'drop'),
  '--permission-prompts': rule('value', 'drop'),
  '--continue': rule('switch', 'drop'),
  '--resume': rule('optional', 'drop'),
  '--from-pr': rule('optional', 'drop'),
  '--session-id': rule('value', 'drop'),
  '--fork-session': rule('switch', 'drop'),
  '--resume-session-at': rule('value', 'drop'),
  '--resume-drops-turn': rule('value', 'drop'),
  '--no-session-persistence': rule('switch', 'drop'),
  '--session-mirror': rule('switch', 'drop'),
  '--await-initialize': rule('switch', 'drop'),
  '--help': rule('switch', 'drop'),
  '--version': rule('switch', 'drop'),
  // These run the session somewhere other than the chat's own folder and process.
  '--worktree': rule('optional', 'refuse'),
  '--tmux': rule('switch', 'refuse'),
  '--bg': rule('switch', 'refuse'),
  '--background': rule('switch', 'refuse'),
  '--cloud': rule('optional', 'refuse'),
  '--teleport': rule('optional', 'refuse'),
  '--remote': rule('optional', 'refuse'),
  '--remote-control': rule('optional', 'refuse'),
  '--rc': rule('optional', 'refuse')
}

const SHORT_OPTIONS: Record<string, string> = {
  '-c': '--continue',
  '-d': '--debug',
  '-h': '--help',
  '-n': '--name',
  '-p': '--print',
  '-r': '--resume',
  '-v': '--version',
  '-w': '--worktree'
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
    } else if (token.length > 2) {
      // `-nNAME` is a short option's value; `-pc` is two switches, as the CLI parser reads them.
      const short = SHORT_OPTIONS[token.slice(0, 2)]
      if (short && RULES[short]?.arity === 'switch') {
        queue.unshift(`-${token.slice(2)}`)
        typed = token.slice(0, 2)
      } else if (short) {
        inline = token.slice(2)
      }
      option = token.slice(0, 2)
    }
    const name = SHORT_OPTIONS[option] ?? option
    const known = RULES[name]
    const tokens = [typed]
    if (inline === undefined) {
      if (known?.arity === 'value' || known?.arity === 'variadic') {
        // A required value is the next token, even one that starts with `-`.
        const value = queue.shift()
        if (value === undefined) {
          throw new StructuredAgentArgumentsError('Claude', option, 'missingValue')
        }
        tokens.push(value)
      }
      if (known?.arity === 'optional' && queue[0] !== undefined && !looksLikeOption(queue[0])) {
        tokens.push(queue.shift()!)
      }
      // An unknown option's arity is the CLI's to judge, so its bare words go with it as typed.
      if (!known || known.arity === 'variadic') {
        while (queue[0] !== undefined && !looksLikeOption(queue[0])) {
          tokens.push(queue.shift()!)
        }
      }
    }
    if (known?.action === 'refuse') {
      throw new StructuredAgentArgumentsError('Claude', option, 'unsupportedOption')
    }
    if (known?.action !== 'drop') {
      // An unknown option is forwarded too: the CLI is the authority on its own options, and one
      // it rejects fails the start with the generic start failure.
      forwarded.push({ option: name, tokens })
    }
  }
  return forwarded
}
