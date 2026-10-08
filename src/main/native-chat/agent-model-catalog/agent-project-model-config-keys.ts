import { parse as parseToml } from 'smol-toml'

// Which keys in a project's own agent config can move a new chat off the account's model or
// effort. A file that sets none (permissions, hooks, MCP servers) leaves the account default.

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

function setsAny(table: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => table[key] !== undefined)
}

// Claude settings keys that pick the model, its effort, or which models Default may resolve to.
const CLAUDE_MODEL_SETTINGS = [
  'model',
  'effortLevel',
  'modelSettings',
  'availableModels',
  'enforceAvailableModels',
  'modelOverrides'
] as const

/** The model, alias-target and effort env vars Claude Code reads, plus the provider switches
 *  that change which model ids exist at all. */
function isClaudeModelEnvKey(key: string): boolean {
  return (
    key === 'ANTHROPIC_MODEL' ||
    key === 'CLAUDE_CODE_EFFORT_LEVEL' ||
    /^ANTHROPIC_DEFAULT_([A-Z]+_)?MODEL$/.test(key) ||
    /^CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY|MANTLE|GATEWAY)$/.test(key)
  )
}

/** True when a Claude settings file's text could pick a model or effort; unreadable JSON counts. */
export function claudeSettingsMayPickModel(text: string): boolean {
  let settings: Record<string, unknown> | null
  try {
    settings = record(JSON.parse(text))
  } catch {
    return true
  }
  if (!settings) {
    return true
  }
  if (setsAny(settings, CLAUDE_MODEL_SETTINGS)) {
    return true
  }
  const env = record(settings.env)
  return env !== null && Object.keys(env).some(isClaudeModelEnvKey)
}

const CODEX_MODEL_KEYS = ['model', 'model_reasoning_effort', 'model_provider'] as const

/** True when a Codex `config.toml`'s text could pick a model or effort, directly or through a
 *  profile; unparseable TOML counts. */
export function codexConfigMayPickModel(text: string): boolean {
  let config: Record<string, unknown>
  try {
    config = parseToml(text)
  } catch {
    return true
  }
  if (setsAny(config, CODEX_MODEL_KEYS) || config.profile !== undefined) {
    return true
  }
  const profiles = record(config.profiles)
  return (
    profiles !== null &&
    Object.values(profiles).some((profile) => {
      const table = record(profile)
      return table === null || setsAny(table, CODEX_MODEL_KEYS)
    })
  )
}
