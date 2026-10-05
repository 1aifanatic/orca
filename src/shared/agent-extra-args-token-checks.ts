import { agentArgTerminatorIndex } from './agent-session-option-agent-args'
import { removeAgentExtraArgsFlag } from './agent-extra-args-families'
import { extraAgentArgsError, type ExtraAgentArgsError } from './agent-extra-args-errors'
import {
  AGENT_SESSION_SUBCOMMANDS,
  getAgentSessionSelectorFlags
} from './agent-session-selector-flags'
import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'
import { REPEATABLE_YOLO_TUI_AGENT_FLAGS, YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'

/** Orca's own prompt and draft flags, each with the flags that would compete with it. */
export function getAgentPromptFlagGroups(agent: TuiAgent): { flag: string; flags: string[] }[] {
  const config = TUI_AGENT_CONFIG[agent]
  const modeFlag = {
    argv: null,
    'flag-prompt': '--prompt',
    'flag-prompt-interactive': '--prompt-interactive',
    'flag-interactive': '-i',
    'hermes-query': '--query',
    'stdin-after-start': null
  }[config.promptInjectionMode]
  return [
    ...(modeFlag
      ? [{ flag: modeFlag, flags: [modeFlag, ...(config.competingPromptFlags ?? [])] }]
      : []),
    ...(config.draftPromptFlag
      ? [
          {
            flag: config.draftPromptFlag,
            flags: [config.draftPromptFlag, ...(config.competingDraftFlags ?? [])]
          }
        ]
      : [])
  ]
}

/** Flags of the agent's permission-bypass default that its CLI can't take twice. */
export function getAgentBypassFlags(agent: TuiAgent, shell: AgentStartupShell): string[] {
  const yolo = YOLO_TUI_AGENT_ARGS[agent]
  const tokenized = yolo ? tokenizeStartupCommand(yolo, shell) : null
  const repeatable = REPEATABLE_YOLO_TUI_AGENT_FLAGS[agent] ?? []
  return (tokenized?.ok ? tokenized.tokens : []).filter(
    (token) => token.startsWith('-') && !repeatable.includes(token)
  )
}

// Without a terminator, an incomplete flag could consume the positional prompt.
export function checkPromptPlacement(
  agent: TuiAgent,
  promptOnCommandLine: boolean
): ExtraAgentArgsError | null {
  const config = TUI_AGENT_CONFIG[agent]
  return promptOnCommandLine && config.promptInjectionMode === 'argv' && !config.argvPromptSeparator
    ? extraAgentArgsError('bare-prompt', 'extras', { agent: TUI_AGENT_DISPLAY_NAMES[agent] })
    : null
}

export function checkExtraTokenShape(
  agent: TuiAgent,
  tokens: readonly string[]
): ExtraAgentArgsError | null {
  if (agentArgTerminatorIndex(agent, tokens) < tokens.length) {
    return extraAgentArgsError('extras-terminator', 'extras')
  }
  // A leading subcommand would change the launch and every replay of its arguments.
  if (!tokens[0]?.startsWith('-')) {
    return extraAgentArgsError('extras-leading-bare-word', 'extras')
  }
  return null
}

export function hasAgentExtraArgsFlag(
  agent: TuiAgent,
  tokens: readonly string[],
  flags: readonly string[]
): boolean {
  return removeAgentExtraArgsFlag(agent, tokens, flags).length < tokens.length
}

/** Session selectors, session subcommands, Orca's prompt flags, and Hermes's `--cli`. */
export function checkOrcaOwnedFlags(
  agent: TuiAgent,
  tokens: readonly string[],
  promptOnCommandLine: boolean
): ExtraAgentArgsError | null {
  const subcommands = AGENT_SESSION_SUBCOMMANDS[agent] ?? []
  if (
    hasAgentExtraArgsFlag(agent, tokens, getAgentSessionSelectorFlags(agent)) ||
    tokens.some((token) => subcommands.includes(token))
  ) {
    return extraAgentArgsError('session-selector', 'extras')
  }
  const promptGroup = getAgentPromptFlagGroups(agent).find((group) =>
    hasAgentExtraArgsFlag(agent, tokens, group.flags)
  )
  if (promptGroup) {
    return extraAgentArgsError('prompt-flag', 'extras', { flag: promptGroup.flag })
  }
  const config = TUI_AGENT_CONFIG[agent]
  // Why: a bare-prompt CLI refuses its own prompt flags next to a positional prompt.
  const competing =
    config.promptInjectionMode === 'argv' && promptOnCommandLine
      ? config.competingPromptFlags?.find((flag) => hasAgentExtraArgsFlag(agent, tokens, [flag]))
      : undefined
  if (competing) {
    return extraAgentArgsError('competing-prompt', 'extras', { flag: competing })
  }
  if (
    config.promptInjectionMode === 'hermes-query' &&
    promptOnCommandLine &&
    hasAgentExtraArgsFlag(agent, tokens, ['--cli'])
  ) {
    return extraAgentArgsError('hermes-cli', 'extras')
  }
  return null
}

const SHELL_LABELS: Record<Exclude<AgentStartupShell, 'posix'>, string> = {
  powershell: 'PowerShell',
  cmd: 'cmd'
}

/** Tokens Orca's Windows quoting may not deliver exactly, so the preview can't promise them. */
function windowsTokenIsUnsafe(token: string, shell: AgentStartupShell): boolean {
  if (shell === 'powershell') {
    // Why: Windows PowerShell 5.1 drops empty arguments and unescaped embedded quotes when it
    // builds a native command line, and its quotes around a spaced token meet a trailing `\`.
    return token === '' || token.includes('"') || (/\s/.test(token) && token.endsWith('\\'))
  }
  if (shell === 'cmd') {
    // Why: quoteStartupArg carets these inside double quotes, where cmd keeps the caret.
    return /[\^&|<>()%!"]/.test(token) || token.endsWith('\\')
  }
  return false
}

export function checkWindowsTokens(
  tokens: readonly string[],
  shell: AgentStartupShell,
  source: 'extras' | 'defaults'
): ExtraAgentArgsError | null {
  if (shell === 'posix') {
    return null
  }
  const token = tokens.find((candidate) => windowsTokenIsUnsafe(candidate, shell))
  return token === undefined
    ? null
    : extraAgentArgsError('windows-token', source, {
        shell: SHELL_LABELS[shell],
        token: token === '' ? "''" : token
      })
}
