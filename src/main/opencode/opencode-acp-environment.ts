import { restoreOrStripOverlayEnv } from '../../shared/agent-overlay-env'

const ORCA_OPENCODE_ENV_PREFIX = 'ORCA_OPENCODE_'
const ACCOUNT_ENV_KEYS = ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'OPENCODE_DB', 'OPENCODE_AUTH_CONTENT']

/**
 * A structured chat's OpenCode must not load Orca's terminal status plugin: an inherited
 * `OPENCODE_CONFIG_DIR` overlay would make the same session report through a second producer.
 * Restores the user's own config directory when one was recorded, and drops every Orca OpenCode
 * variable. Runs after the pinned account is applied. Returns the keys the child must not inherit.
 */
export function scrubOpenCodeAcpEnvironment(
  env: Record<string, string>,
  inherited: NodeJS.ProcessEnv
): string[] {
  const view: Record<string, string> = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) {
      view[key] = value
    }
  }
  Object.assign(view, env)
  restoreOrStripOverlayEnv(
    view,
    {
      primary: 'OPENCODE_CONFIG_DIR',
      overlay: 'ORCA_OPENCODE_CONFIG_DIR',
      source: 'ORCA_OPENCODE_SOURCE_CONFIG_DIR',
      preserveExplicitPrimary: true
    },
    {}
  )
  const removed: string[] = []
  if (view.OPENCODE_CONFIG_DIR === undefined) {
    delete env.OPENCODE_CONFIG_DIR
    removed.push('OPENCODE_CONFIG_DIR')
  } else {
    env.OPENCODE_CONFIG_DIR = view.OPENCODE_CONFIG_DIR
  }
  // The pinned account sets each of these it uses; one it leaves unset must not come from Orca's.
  for (const key of ACCOUNT_ENV_KEYS) {
    if (env[key] === undefined) {
      removed.push(key)
    }
  }
  for (const key of new Set([...Object.keys(env), ...Object.keys(inherited)])) {
    if (key.startsWith(ORCA_OPENCODE_ENV_PREFIX)) {
      delete env[key]
      removed.push(key)
    }
  }
  return removed
}
