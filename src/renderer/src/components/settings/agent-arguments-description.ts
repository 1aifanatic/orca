// The one line under an agent's Arguments field that says where they apply. Only agents with a
// structured chat have one: that chat ignores saved Arguments, while terminal tabs and the
// terminal-backed chat still launch with them.
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../../shared/tui-agent'

export function agentArgumentsDescription(agent: TuiAgent): string | undefined {
  switch (agent) {
    case 'claude':
      return translate(
        'auto.components.settings.AgentsPane.argumentsUse.claude',
        "Used when Claude runs in a terminal, including terminal chats. Structured chats don't use these; put their settings in ~/.claude/settings.json."
      )
    case 'codex':
      return translate(
        'auto.components.settings.AgentsPane.argumentsUse.codex',
        "Used when Codex runs in a terminal, including terminal chats. Structured chats don't use these; put their settings in ~/.codex/config.toml."
      )
    case 'grok':
      return translate(
        'auto.components.settings.AgentsPane.argumentsUse.grok',
        "Used when Grok runs in a terminal, including terminal chats. Structured chats don't use these; put their settings in ~/.grok/config.toml."
      )
    case 'opencode':
      return translate(
        'auto.components.settings.AgentsPane.argumentsUse.opencode',
        "Used when OpenCode runs in a terminal, including terminal chats. Structured chats don't use these; put their settings in ~/.config/opencode/opencode.json."
      )
    case 'omp':
      return translate(
        'auto.components.settings.AgentsPane.argumentsUse.omp',
        "Used when OMP runs in a terminal, including terminal chats. Structured chats don't use these."
      )
    default:
      return undefined
  }
}
