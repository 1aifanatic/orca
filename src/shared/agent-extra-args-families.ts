import { removeAgentArgOption } from './agent-session-option-agent-args'
import { getAgentSessionOptionLaunchCatalog } from './agent-session-option-launch'
import type { CatalogOption, CatalogOptionApply } from './agent-session-option-catalog-types'
import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

export type ExtraArgsFamily = {
  label: string
  remove: (tokens: readonly string[]) => string[]
}

const DEFAULT_SINGLETON_OPTIONS: readonly (readonly string[])[] = [['--model']]

export function removeAgentExtraArgsFlag(
  agent: TuiAgent,
  tokens: readonly string[],
  flags: readonly string[]
): string[] {
  const abbreviated = TUI_AGENT_CONFIG[agent].abbreviatesLongFlags
    ? tokens.flatMap((token) => {
        const name = token.split('=')[0]
        return name.startsWith('--') &&
          name.length > 3 &&
          flags.some((flag) => flag.startsWith('--') && flag.startsWith(name))
          ? [name]
          : []
      })
    : []
  return removeAgentArgOption(agent, tokens, [...flags, ...abbreviated])
}

function catalogOptions(agent: TuiAgent): CatalogOption[] {
  const catalog = getAgentSessionOptionLaunchCatalog(agent)
  if (!catalog) {
    return []
  }
  const byId = new Map<string, CatalogOption>()
  for (const option of [
    ...catalog.models.flatMap((model) => model.options),
    ...(catalog.unknownModelOptions ?? [])
  ]) {
    if (!byId.has(option.id) && option.apply.removeAgentArgs) {
      byId.set(option.id, option)
    }
  }
  return [...byId.values()]
}

/** The flag as the user would type it: `--model`, or `-c model_reasoning_effort=…` for Codex. */
function flagLabel(apply: CatalogOptionApply, fallback: string): string {
  return apply.launchArgs?.('…').join(' ').replace(/ …$/, '') || fallback
}

// Catalog removers recognize aliases and config keys without a second detector.
function getCatalogFamilies(agent: TuiAgent): ExtraArgsFamily[] {
  const catalog = getAgentSessionOptionLaunchCatalog(agent)
  const model = catalog?.modelApply
  return [
    ...(model?.removeAgentArgs
      ? [
          {
            label: flagLabel(model, 'model'),
            remove: model.removeAgentArgs
          }
        ]
      : []),
    ...catalogOptions(agent).flatMap((option) =>
      option.apply.removeAgentArgs
        ? [
            {
              label: flagLabel(option.apply, option.label),
              remove: option.apply.removeAgentArgs
            }
          ]
        : []
    )
  ]
}

export function getExtraArgsFamilies(
  agent: TuiAgent,
  bypassFlags: readonly string[]
): ExtraArgsFamily[] {
  const singletons = TUI_AGENT_CONFIG[agent].singletonOptions ?? DEFAULT_SINGLETON_OPTIONS
  const catalogFamilies = getCatalogFamilies(agent)
  return [
    ...catalogFamilies,
    ...(getAgentSessionOptionLaunchCatalog(agent)?.modelApply.removeAgentArgs
      ? []
      : singletons
    ).map((aliases) => ({
      label: aliases[0],
      remove: (tokens: readonly string[]) => removeAgentExtraArgsFlag(agent, tokens, aliases)
    })),
    ...bypassFlags.map((flag) => ({
      label: flag,
      remove: (tokens: readonly string[]) => removeAgentExtraArgsFlag(agent, tokens, [flag])
    }))
  ]
}

export function extraArgsFamilyIsPresent(
  family: ExtraArgsFamily,
  tokens: readonly string[]
): boolean {
  return family.remove(tokens).length < tokens.length
}

export function findRepeatedFamily(
  typed: readonly ExtraArgsFamily[],
  tokens: readonly string[]
): ExtraArgsFamily | null {
  for (const family of typed) {
    // A prefix that matches stays matched as it grows, so binary-search the shortest one.
    let low = 1
    let high = tokens.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (extraArgsFamilyIsPresent(family, tokens.slice(0, middle))) {
        high = middle
      } else {
        low = middle + 1
      }
    }
    // A prefix can end at the flag before its value; keep that value with the first occurrence.
    if (
      low < tokens.length &&
      !tokens[low].startsWith('-') &&
      family.remove(tokens.slice(0, low + 1)).length === family.remove(tokens.slice(0, low)).length
    ) {
      low += 1
    }
    if (extraArgsFamilyIsPresent(family, tokens.slice(low))) {
      return family
    }
  }
  return null
}
