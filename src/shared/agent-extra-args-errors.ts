/** English templates for every refusal; `{{name}}` matches i18next interpolation. */
export const EXTRA_AGENT_ARGS_ERROR_TEMPLATES = {
  'bare-prompt':
    "{{agent}} can't take extra arguments with a prompt yet. Clear the Note or the arguments.",
  'extras-unclosed-quote': 'Unclosed quote in extra arguments.',
  'extras-terminator': "Extra arguments can't include `--`.",
  'extras-leading-bare-word':
    "Extra arguments must start with a flag, such as `--model`. Subcommands aren't supported.",
  'defaults-unclosed-quote':
    'Your default arguments for {{agent}} have an unclosed quote. Fix them in Settings → Agents.',
  'override-unclosed-quote':
    'Your command override for {{agent}} has an unclosed quote. Fix it in Settings → Agents.',
  'defaults-set-flag':
    'Your default arguments for {{agent}} already set {{flag}}. Change it in Settings → Agents.',
  'override-sets-option':
    'Your command override for {{agent}} already sets {{option}}. Remove it there or from the extra arguments.',
  'session-selector': "Extra arguments can't choose a session. Orca resumes sessions itself.",
  'prompt-flag': 'Orca uses {{flag}} to pass the prompt.',
  'competing-prompt':
    "{{flag}} can't be used with the prompt Orca passes. Clear the Note or {{flag}}.",
  'hermes-cli': 'Orca sets --cli itself when Hermes starts with a prompt.',
  'windows-token': "{{shell}} can't pass {{token}} to the agent exactly yet.",
  'repeated-option': '{{option}} appears twice in the extra arguments.',
  'rebuild-failed': "Couldn't combine these arguments with your defaults. Check the quoting.",
  'too-large': 'Agent arguments are too large.',
  'omp-fresh-session': "Orca can't start a new OMP session with {{token}} yet.",
  'hermes-too-large': 'The prompt and arguments are too long to start Hermes with. Shorten them.',
  'hermes-no-executable':
    "Your command override for Hermes doesn't run a `hermes` executable, so Orca can't pass it the prompt.",
  'hermes-env-assignments':
    'Your command override for Hermes sets environment variables, which only POSIX shells can pass with a prompt.',
  'launch-command': '{{detail}}'
} as const

export type ExtraAgentArgsErrorCode = keyof typeof EXTRA_AGENT_ARGS_ERROR_TEMPLATES

/** Which text the user has to change: the field, Settings defaults, or the command override. */
export type ExtraAgentArgsErrorSource = 'extras' | 'defaults' | 'override'

export type ExtraAgentArgsError = {
  code: ExtraAgentArgsErrorCode
  source: ExtraAgentArgsErrorSource
  params: Record<string, string>
  /** The English message; renderers translate from `code` and `params` instead. */
  message: string
}

export function formatExtraAgentArgsError(
  code: ExtraAgentArgsErrorCode,
  params: Record<string, string>
): string {
  return EXTRA_AGENT_ARGS_ERROR_TEMPLATES[code].replace(
    /\{\{(\w+)\}\}/g,
    (match, name: string) => params[name] ?? match
  )
}

export function extraAgentArgsError(
  code: ExtraAgentArgsErrorCode,
  source: ExtraAgentArgsErrorSource,
  params: Record<string, string> = {}
): ExtraAgentArgsError {
  return { code, source, params, message: formatExtraAgentArgsError(code, params) }
}
