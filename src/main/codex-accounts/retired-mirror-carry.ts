import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { observeAgentStateFile } from '../codex/codex-path-observation'
import { promoteCodexRuntimeSettingsToSystem } from '../codex/config-settings-promotion'
import { resolvePromotionWriteTarget } from '../codex/config-settings-promotion-write-target'
import { readCodexSettingsBaseline } from '../codex/config-settings-baseline'
import { promoteCodexRuntimeHookApprovalsToSystem } from '../codex/hook-trust-promotion'
import {
  readMcpServerTomlOwnership,
  readTomlRootTableOwnership
} from '../codex/config-toml-mcp-servers'
import {
  normalizeCodexProjectPathForLookup,
  normalizeCodexProjectPathForRevocationLookup,
  parseCodexProjectHeaderPath
} from '../codex/config-toml-trust'
import {
  deduplicateProjectTomlSections,
  extractOrdinaryCodexSettings,
  getMcpServerTomlSectionName,
  getTomlSections,
  isRuntimeProjectTomlSection,
  joinTomlBlocks
} from '../codex/config-toml-runtime-owned-sections'
import { writeFileAtomicallyIfUnchanged } from './fs-utils'

export const RETIRED_MIRROR_CARRY_MARKER = 'retired-mirror-carry-v1.json'

type RetiredMirrorHomes = {
  runtimeHomePath: string
  systemHomePath: string
}

/**
 * Carries the config only the system-default mirror holds into ~/.codex when
 * that lane retires. Promotion salvages settings only inside a mirror pass, and
 * the mirror keeps project trust and its own MCP servers to itself, so without
 * this the first real-home launch would drop them.
 *
 * Additive: never replaces anything ~/.codex already has. Every step runs even
 * when another fails, and the result says whether all of them landed.
 */
export function carryRetiredMirrorConfig(homes: RetiredMirrorHomes): boolean {
  // Why first: a fresh user may have no ~/.codex until Codex first runs there.
  mkdirSync(homes.systemHomePath, { recursive: true, mode: 0o700 })
  return [
    () => promoteCodexRuntimeSettingsToSystem(homes) !== null,
    () => promoteCodexRuntimeHookApprovalsToSystem(homes.runtimeHomePath),
    () => carryMirrorOnlyTables(homes)
  ]
    .map(runStep)
    .every(Boolean)
}

function runStep(step: () => boolean): boolean {
  try {
    return step()
  } catch (error) {
    console.warn('[codex-runtime-home] Failed to carry the retired mirror into ~/.codex:', error)
    return false
  }
}

/** False when ~/.codex changed underneath, so the carry retries. */
function carryMirrorOnlyTables({ runtimeHomePath, systemHomePath }: RetiredMirrorHomes): boolean {
  const runtimeObservation = observeAgentStateFile(join(runtimeHomePath, 'config.toml'))
  if (runtimeObservation.kind === 'indeterminate') {
    throw runtimeObservation.error
  }
  if (runtimeObservation.kind === 'absent') {
    return true
  }
  const writeTarget = resolvePromotionWriteTarget(join(systemHomePath, 'config.toml'))
  const systemObservation = observeAgentStateFile(writeTarget.path)
  if (systemObservation.kind === 'indeterminate') {
    throw systemObservation.error
  }
  const runtimeConfig = runtimeObservation.value
  const systemConfig = systemObservation.kind === 'present' ? systemObservation.value : null
  // Why: with no config of its own, the mirror was the user's only config, so
  // its ordinary settings carry too — promotion alone skips any it baselined.
  const baseConfig = systemConfig?.trim()
    ? systemConfig
    : extractOrdinaryCodexSettings(runtimeConfig)
  const baseOwns = readTableOwnership(baseConfig)
  const baseline = readCodexSettingsBaseline(runtimeHomePath)
  // Why: an MCP server the mirror copied from ~/.codex and the user since
  // removed there stays gone. Projects have no such record, so one deleted
  // from ~/.codex but still trusted in the mirror's panes carries back.
  const removedFromSystem = (header: string): boolean => {
    const mcpServerName = getMcpServerTomlSectionName(header)
    return (
      mcpServerName !== null &&
      (baseline?.mcpServerRoot === true || baseline?.mcpServers.has(mcpServerName) === true)
    )
  }
  const tables = deduplicateProjectTomlSections(getTomlSections(runtimeConfig))
    .filter(
      ({ header }) => isCarriedTable(header) && !baseOwns(header) && !removedFromSystem(header)
    )
    .map((section) => section.block)
  const nextConfig = joinTomlBlocks([baseConfig, ...tables])
  return (
    nextConfig === joinTomlBlocks([systemConfig ?? '']) ||
    writeFileAtomicallyIfUnchanged(writeTarget.path, systemConfig, nextConfig, {
      mode: writeTarget.mode
    })
  )
}

function isCarriedTable(header: string): boolean {
  return isRuntimeProjectTomlSection(header) || getMcpServerTomlSectionName(header) !== null
}

/**
 * Whether a config already declares a project or MCP server table, in any TOML
 * form. Appending a table it declares inline would make the file invalid, and a
 * project it names at all — trusted or revoked — is the user's decision.
 */
function readTableOwnership(config: string): (header: string) => boolean {
  const projects = readTomlRootTableOwnership(config, 'projects')
  const projectKeys = new Set([...projects.names].flatMap(projectLookupKeys))
  const mcpServers = readMcpServerTomlOwnership(config)
  return (header) => {
    const projectPath = parseCodexProjectHeaderPath(header)
    if (projectPath !== null) {
      return projects.ownsRoot || projectLookupKeys(projectPath).some((key) => projectKeys.has(key))
    }
    const mcpServerName = getMcpServerTomlSectionName(header)
    return mcpServerName !== null && (mcpServers.ownsRoot || mcpServers.names.has(mcpServerName))
  }
}

// Why both: a revocation written under drifted casing still names the project.
function projectLookupKeys(projectPath: string): string[] {
  return [
    normalizeCodexProjectPathForLookup(projectPath),
    `revocation:${normalizeCodexProjectPathForRevocationLookup(projectPath)}`
  ]
}
