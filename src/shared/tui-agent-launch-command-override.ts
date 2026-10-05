import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { agentArgTerminatorIndex, removeAgentArgOption } from './agent-session-option-agent-args'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'

export type StructuredAgentCommandInvocation = {
  command: string
  prefixArgs: readonly string[]
  /** Custom wrappers can resolve scripts and configuration relative to this directory. */
  cwd?: string
}

/** Command applies to structured chat too; the separate Arguments field remains terminal-only. */
export function parseStructuredAgentCommandOverride(
  command: string | null | undefined,
  platform: NodeJS.Platform
): StructuredAgentCommandInvocation | null {
  const value = command?.trim()
  if (!value) {
    return null
  }
  const parsed = tokenizeStartupCommand(value, platform === 'win32' ? 'powershell' : 'posix')
  if (
    /[\0\r\n]/.test(value) ||
    !parsed.ok ||
    parsed.spans.some((span) => span.divergesFromShell) ||
    hasShellExpansion(value, platform)
  ) {
    throw new Error('custom command requires shell evaluation')
  }
  const [binary, ...prefixArgs] = parsed.tokens
  if (!binary || /^[A-Za-z_][A-Za-z0-9_]*=/.test(binary)) {
    throw new Error('custom command must name a program')
  }
  return { command: binary, prefixArgs }
}

function hasShellExpansion(value: string, platform: NodeJS.Platform): boolean {
  let quote: string | null = null
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === (platform === 'win32' ? '`' : '\\') && quote !== "'") {
      index += 1
      continue
    }
    if (quote === "'" && char !== "'") {
      continue
    }
    if (char === quote) {
      quote = null
      continue
    }
    if (!quote && (char === "'" || char === '"')) {
      quote = char
      continue
    }
    if (char === '$' || char === '`' || (!quote && '*?[]{}()'.includes(char))) {
      return true
    }
    if (platform === 'win32' && char === '%' && /%[^%]+%/.test(value.slice(index))) {
      return true
    }
  }
  return false
}

/** Reject flags that would take ownership of the structured transport or a requested pick. */
export function validateStructuredAgentCommandArgs(
  agent: 'claude' | 'codex',
  args: readonly string[],
  options: Readonly<Record<string, unknown>> = {}
): 'customCommandInvalid' | 'customCommandConflict' | undefined {
  const owned =
    agent === 'claude'
      ? [
          '-p',
          '--print',
          '--input-format',
          '--output-format',
          '--verbose',
          '--session-id',
          '--resume',
          '-r',
          '--continue',
          '-c',
          '--fork-session',
          '--permission-prompt-tool',
          '--permission-mode',
          '--dangerously-skip-permissions',
          '--allow-dangerously-skip-permissions',
          '--settings',
          '--setting-sources',
          '--resume-session-at',
          '--permission-prompts',
          '--remote',
          '--teleport',
          '--environment',
          '--worktree',
          '-w',
          '--replay-user-messages'
        ]
      : [
          '--listen',
          '--cwd',
          '--cd',
          '-C',
          '--session',
          '--resume',
          '--sandbox',
          '--ask-for-approval',
          '--dangerously-bypass-approvals-and-sandbox'
        ]
  if (
    agentArgTerminatorIndex(agent, args) < args.length ||
    args.some((arg) => /^(CODEX_HOME|CLAUDE_CONFIG_DIR)=/.test(arg)) ||
    removeAgentArgOption(agent, args, owned).length !== args.length ||
    (agent === 'codex' &&
      removeAgentArgOption(agent, args, ['-c', '--config'], (value) =>
        /^(sandbox_mode|approval_policy|forced_login_method|forced_chatgpt_workspace_id|cli_auth_credentials_store)\s*=/.test(
          value ?? ''
        )
      ).length !== args.length)
  ) {
    return 'customCommandInvalid'
  }
  const catalog = getAgentSessionOptionCatalog(agent)
  if (!catalog) {
    return undefined
  }
  const removesModel = catalog.modelApply.removeAgentArgs
  if (
    typeof options.model === 'string' &&
    options.model.trim() !== '' &&
    removesModel &&
    removesModel(args).length !== args.length
  ) {
    return 'customCommandConflict'
  }
  const effort =
    catalog.unknownModelOptions?.find((option) => option.id === 'effort') ??
    catalog.models.flatMap((model) => model.options ?? []).find((option) => option.id === 'effort')
  const removesEffort = effort?.apply.removeAgentArgs
  if (
    typeof options.effort === 'string' &&
    options.effort.trim() !== '' &&
    removesEffort &&
    removesEffort(args).length !== args.length
  ) {
    return 'customCommandConflict'
  }
  return undefined
}
