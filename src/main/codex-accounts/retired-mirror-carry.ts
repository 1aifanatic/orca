import { existsSync, mkdirSync, readFileSync } from 'node:fs'
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
 * Carries the settings only the system-default mirror holds into ~/.codex when
 * that lane retires. Promotion salvages settings only inside a mirror pass, and
 * the mirror keeps project trust and its own MCP servers to itself, so without
 * this the first real-home launch would drop them.
 *
 * Additive: never replaces anything ~/.codex already has. Every step runs even
 * when another fails, and the result says whether all of them landed.
 */
export function carryRetiredMirrorSettings(
  homes: RetiredMirrorHomes,
  options: { mirrorOwnedBySystemDefault: boolean }
): boolean {
  // Why first: a fresh user may have no ~/.codex until Codex first runs there.
  mkdirSync(homes.systemHomePath, { recursive: true, mode: 0o700 })
  const steps = [
    () => promoteCodexRuntimeSettingsToSystem(homes) !== null,
    () => promoteCodexRuntimeHookApprovalsToSystem(homes.runtimeHomePath),
    () => carryMirrorOnlyConfig(homes),
    () => {
      // Why: MCP OAuth tokens live beside auth.json, so a sign-in done inside an
      // Orca pane exists only in the mirror.
      if (options.mirrorOwnedBySystemDefault) {
        copyIfAbsent(
          join(homes.runtimeHomePath, '.credentials.json'),
          join(homes.systemHomePath, '.credentials.json')
        )
      }
      return true
    }
  ]
  return steps.map(runStep).every(Boolean)
}

function runStep(step: () => boolean): boolean {
  try {
    return step()
  } catch (error) {
    console.warn('[codex-runtime-home] Failed to carry the retired mirror into ~/.codex:', error)
    return false
  }
}

/** False when either config changed underneath, so the carry retries. */
function carryMirrorOnlyConfig({ runtimeHomePath, systemHomePath }: RetiredMirrorHomes): boolean {
  const runtimeConfigPath = join(runtimeHomePath, 'config.toml')
  const runtimeObservation = observeAgentStateFile(runtimeConfigPath)
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
  // removed there stays gone.
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
  if (
    nextConfig !== joinTomlBlocks([systemConfig ?? '']) &&
    !writeFileAtomicallyIfUnchanged(writeTarget.path, systemConfig, nextConfig, {
      mode: writeTarget.mode
    })
  ) {
    return false
  }
  // Why move, not copy: once ~/.codex owns a table, a later mirror pass takes it
  // from there and a removal the user makes there sticks. Pruning everything it
  // owns (not just this pass's tables) keeps an interrupted move retryable.
  const nextOwns = readTableOwnership(nextConfig)
  const owned = getTomlSections(runtimeConfig).filter(
    ({ header }) => isCarriedTable(header) && nextOwns(header)
  )
  return (
    owned.length === 0 ||
    writeFileAtomicallyIfUnchanged(
      runtimeConfigPath,
      runtimeConfig,
      owned.reduce((config, section) => config.replace(section.block, ''), runtimeConfig)
    )
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

function copyIfAbsent(sourcePath: string, targetPath: string): void {
  if (existsSync(sourcePath)) {
    // Why no overwrite: a sign-in Codex wrote to ~/.codex meanwhile is newer.
    writeFileAtomicallyIfUnchanged(targetPath, null, readFileSync(sourcePath, 'utf-8'), {
      mode: 0o600
    })
  }
}
