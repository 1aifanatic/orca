// The one line under an agent's Arguments field that says where they apply. Only agents with a
// native chat have one: that chat ignores saved Arguments, which only a CLI launch uses.
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../../shared/tui-agent'

const ARGUMENTS_DESCRIPTIONS: Partial<Record<TuiAgent, () => string>> = {
  claude: () =>
    translate(
      'auto.components.settings.AgentsPane.argumentsUse.claude',
      'Used when Claude CLI is launched. Native chat does not use these; put its settings in ~/.claude/settings.json.'
    ),
  codex: () =>
    translate(
      'auto.components.settings.AgentsPane.argumentsUse.codex',
      'Used when Codex CLI is launched. Native chat does not use these; put its settings in ~/.codex/config.toml.'
    ),
  grok: () =>
    translate(
      'auto.components.settings.AgentsPane.argumentsUse.grok',
      'Used when Grok CLI is launched. Native chat does not use these; put its settings in ~/.grok/config.toml.'
    ),
  opencode: () =>
    translate(
      'auto.components.settings.AgentsPane.argumentsUse.opencode',
      'Used when OpenCode CLI is launched. Native chat does not use these; put its settings in ~/.config/opencode/opencode.json.'
    ),
  omp: () =>
    translate(
      'auto.components.settings.AgentsPane.argumentsUse.omp',
      'Used when OMP CLI is launched. Native chat does not use these.'
    )
}

export function agentArgumentsDescription(agent: TuiAgent): string | undefined {
  return ARGUMENTS_DESCRIPTIONS[agent]?.()
}
