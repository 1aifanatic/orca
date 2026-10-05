import { hasFlag } from './agent-cli-flag-detection'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import type { CatalogOption, CatalogOptionApply } from './agent-session-option-catalog-types'
import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

/** A detector run on the extras paired with a remover run on the defaults. */
export type ExtraArgsFamily = {
  label: string
  detect: (tokens: readonly string[]) => boolean
  /** Absent when Orca can't remove it from the defaults, such as a permission-bypass flag. */
  remove?: (tokens: readonly string[]) => string[]
}

const DEFAULT_SINGLETON_OPTIONS: readonly (readonly string[])[] = [['--model']]

function catalogOptions(agent: TuiAgent): CatalogOption[] {
  const catalog = getAgentSessionOptionCatalog(agent)
  if (!catalog) {
    return []
  }
  const byId = new Map<string, CatalogOption>()
  for (const option of [
    ...catalog.models.flatMap((model) => model.options),
    ...(catalog.unknownModelOptions ?? [])
  ]) {
    if (!byId.has(option.id) && option.apply.agentArgsOverride) {
      byId.set(option.id, option)
    }
  }
  return [...byId.values()]
}

/** The flag as the user would type it: `--model`, or `-c model_reasoning_effort=…` for Codex. */
function flagLabel(apply: CatalogOptionApply, fallback: string): string {
  const placeholder = '\u0000'
  const spelled = apply.launchArgs?.(placeholder).join(' ')
  return spelled ? spelled.replace(` ${placeholder}`, '').replace(placeholder, '…') : fallback
}

/** Families whose detectors are the catalog's, so `-c model_reasoning_effort=` is found without
 *  treating every Codex `-c` as a replacement. */
export function getCatalogFamilies(agent: TuiAgent): ExtraArgsFamily[] {
  const catalog = getAgentSessionOptionCatalog(agent)
  const model = catalog?.modelApply
  return [
    ...(model?.agentArgsOverride
      ? [
          {
            label: flagLabel(model, 'model'),
            detect: model.agentArgsOverride,
            remove: model.removeAgentArgs
          }
        ]
      : []),
    ...catalogOptions(agent).flatMap((option) =>
      option.apply.agentArgsOverride
        ? [
            {
              label: flagLabel(option.apply, option.label),
              detect: option.apply.agentArgsOverride,
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
  return [
    ...getCatalogFamilies(agent),
    ...singletons.map((aliases) => ({
      label: aliases[0],
      detect: (tokens: readonly string[]) => hasFlag(tokens, aliases),
      remove: (tokens: readonly string[]) => removeAgentArgOption(tokens, aliases)
    })),
    ...bypassFlags.map((flag) => ({
      label: flag,
      detect: (tokens: readonly string[]) => hasFlag(tokens, [flag])
    }))
  ]
}

/** Detectors only look for flags, so after the shortest matching prefix a second match is a
 *  second copy rather than a value that looks like one. `typed` holds the families that occur. */
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
      if (family.detect(tokens.slice(0, middle))) {
        high = middle
      } else {
        low = middle + 1
      }
    }
    if (family.detect(tokens.slice(low))) {
      return family
    }
  }
  return null
}

/** `catalog_only` when the extras hold nothing but the agent's catalog options. */
export function classifyExtraArgs(
  agent: TuiAgent,
  tokens: readonly string[]
): 'catalog_only' | 'other' {
  const families = getCatalogFamilies(agent)
  let rest: readonly string[] = tokens
  for (const family of families) {
    rest = family.remove?.(rest) ?? rest
  }
  return families.length > 0 && rest.length === 0 ? 'catalog_only' : 'other'
}
