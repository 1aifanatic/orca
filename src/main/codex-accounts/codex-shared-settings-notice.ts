import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { observe, observeAgentStateFile } from '../codex/codex-path-observation'
import { observeCodexSettingsBaseline } from '../codex/config-settings-baseline'
import {
  isRuntimeOnlyMcpServer,
  readMcpServerTomlOwnership
} from '../codex/config-toml-mcp-servers'
import type { CodexSharedSettingsNotice } from '../../shared/codex-config-sync-types'

/**
 * What the Windows notice must say now that system-default Codex runs on
 * ~/.codex, or null when Orca's managed home was never really used.
 * Throws when a read cannot answer.
 */
export function resolveCodexSharedSettingsNotice(
  runtimeHomePath: string,
  systemHomePath: string
): CodexSharedSettingsNotice | null {
  const mcpServerNames = readRuntimeOnlyMcpServerNames(runtimeHomePath, systemHomePath)
  // Why not config.toml: Orca's hook install writes it on every startup, used or not.
  return mcpServerNames.length > 0 || hasSessions(runtimeHomePath) ? { mcpServerNames } : null
}

function readRuntimeOnlyMcpServerNames(runtimeHomePath: string, systemHomePath: string): string[] {
  const runtimeNames = readMcpServerTomlOwnership(readConfigToml(runtimeHomePath) ?? '').names
  if (runtimeNames.size === 0) {
    return []
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
  return [...runtimeNames].filter((name) => isRuntimeOnlyMcpServer(name, system, lastMirrored))
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
