import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { observe, observeAgentStateFile } from '../codex/codex-path-observation'
import { observeCodexSettingsBaseline } from '../codex/config-settings-baseline'
import {
  isRuntimeOnlyMcpServer,
  readMcpServerTomlOwnership
} from '../codex/config-toml-mcp-servers'
import type { CodexSharedSettingsNotice } from '../../shared/persisted-ui-state-types'

/**
 * What the one-time Windows notice must say once system-default Codex leaves
 * Orca's managed home for ~/.codex, or null when that home was never used.
 * Throws when a read cannot answer, so the caller decides on a later pass.
 */
export function resolveCodexSharedSettingsNotice(
  runtimeHomePath: string,
  systemHomePath: string
): CodexSharedSettingsNotice | null {
  const runtimeConfig = readConfigToml(runtimeHomePath)
  if (runtimeConfig === null && !hasSessions(runtimeHomePath)) {
    return null
  }
  const baseline = observeCodexSettingsBaseline(runtimeHomePath)
  if (baseline.kind === 'indeterminate') {
    throw new Error('Codex settings baseline could not be read')
  }
  const lastMirrored =
    baseline.kind === 'present'
      ? { names: baseline.baseline.mcpServers, ownsRoot: baseline.baseline.mcpServerRoot }
      : { names: new Set<string>(), ownsRoot: false }
  const system = readMcpServerTomlOwnership(readConfigToml(systemHomePath) ?? '')
  return {
    mcpServerNames: [...readMcpServerTomlOwnership(runtimeConfig ?? '').names].filter((name) =>
      isRuntimeOnlyMcpServer(name, system, lastMirrored)
    )
  }
}

function readConfigToml(homePath: string): string | null {
  const observation = observeAgentStateFile(join(homePath, 'config.toml'))
  if (observation.kind === 'indeterminate') {
    throw observation.error
  }
  return observation.kind === 'present' ? observation.value : null
}

function hasSessions(homePath: string): boolean {
  const observation = observe(() => readdirSync(join(homePath, 'sessions')).length > 0)
  if (observation.kind === 'indeterminate') {
    throw observation.error
  }
  return observation.kind === 'present' && observation.value
}
