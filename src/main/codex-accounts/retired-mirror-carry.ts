import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { observeAgentStateFile } from '../codex/codex-path-observation'
import { promoteCodexRuntimeSettingsToSystem } from '../codex/config-settings-promotion'
import { resolvePromotionWriteTarget } from '../codex/config-settings-promotion-write-target'
import {
  readCodexSettingsBaseline,
  type CodexSettingsBaseline
} from '../codex/config-settings-baseline'
import { promoteCodexRuntimeHookApprovalsToSystem } from '../codex/hook-trust-promotion'
import { readMcpServerTomlOwnership } from '../codex/config-toml-mcp-servers'
import {
  deduplicateProjectTomlSections,
  extractOrdinaryCodexSettings,
  getMcpServerTomlSectionName,
  getRevocationTomlSectionHeaderKey,
  getTomlSectionHeaderKey,
  getTomlSections,
  isRuntimeProjectTomlSection,
  joinTomlBlocks
} from '../codex/config-toml-runtime-owned-sections'
import { writeFileAtomically, writeFileAtomicallyIfUnchanged } from './fs-utils'

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
  options: { carryMcpCredentials: boolean }
): boolean {
  // Why first: a fresh user may have no ~/.codex until Codex first runs there.
  mkdirSync(homes.systemHomePath, { recursive: true, mode: 0o700 })
  const steps = [
    () => promoteCodexRuntimeSettingsToSystem(homes) !== null,
    () => promoteCodexRuntimeHookApprovalsToSystem(homes.runtimeHomePath),
    () => carryMirrorOnlyConfig(homes),
    // Why: MCP OAuth tokens live beside auth.json, so a sign-in done inside an
    // Orca pane exists only in the mirror.
    () =>
      !options.carryMcpCredentials ||
      copyIfAbsent(
        join(homes.runtimeHomePath, '.credentials.json'),
        join(homes.systemHomePath, '.credentials.json')
      )
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

/** False when ~/.codex/config.toml changed underneath, so the carry retries. */
function carryMirrorOnlyConfig({ runtimeHomePath, systemHomePath }: RetiredMirrorHomes): boolean {
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
  const systemConfig = systemObservation.kind === 'present' ? systemObservation.value : null
  // Why: with no config of its own, the mirror was the user's only config, so
  // its ordinary settings carry too — promotion alone skips any it baselined.
  const baseConfig = systemConfig?.trim()
    ? systemConfig
    : extractOrdinaryCodexSettings(runtimeObservation.value)
  const nextConfig = joinTomlBlocks([
    baseConfig,
    ...selectMirrorOnlyTables(
      runtimeObservation.value,
      baseConfig,
      readCodexSettingsBaseline(runtimeHomePath)
    )
  ])
  if (nextConfig === joinTomlBlocks([systemConfig ?? ''])) {
    return true
  }
  return writeFileAtomicallyIfUnchanged(writeTarget.path, systemConfig, nextConfig, {
    mode: writeTarget.mode
  })
}

/**
 * Project trust and MCP servers the mirror kept for itself. A project ~/.codex
 * names at all, trusted or revoked, is the user's decision and wins; an MCP
 * server the mirror copied from ~/.codex and the user since removed stays gone.
 */
function selectMirrorOnlyTables(
  runtimeConfig: string,
  systemConfig: string,
  baseline: CodexSettingsBaseline | null
): string[] {
  const systemSections = getTomlSections(systemConfig)
  const systemProjects = new Set(
    systemSections
      .filter((section) => isRuntimeProjectTomlSection(section.header))
      .flatMap((section) => [
        getTomlSectionHeaderKey(section.header),
        getRevocationTomlSectionHeaderKey(section.header)
      ])
  )
  const systemMcpServers = readMcpServerTomlOwnership(systemConfig)
  const mcpServersOwnedElsewhere = systemMcpServers.ownsRoot || baseline?.mcpServerRoot === true
  return deduplicateProjectTomlSections(getTomlSections(runtimeConfig))
    .filter((section) => {
      if (isRuntimeProjectTomlSection(section.header)) {
        return (
          !systemProjects.has(getTomlSectionHeaderKey(section.header)) &&
          !systemProjects.has(getRevocationTomlSectionHeaderKey(section.header))
        )
      }
      const mcpServerName = getMcpServerTomlSectionName(section.header)
      return (
        mcpServerName !== null &&
        !mcpServersOwnedElsewhere &&
        !systemMcpServers.names.has(mcpServerName) &&
        !baseline?.mcpServers.has(mcpServerName)
      )
    })
    .map((section) => section.block)
}

function copyIfAbsent(sourcePath: string, targetPath: string): boolean {
  if (existsSync(sourcePath) && !existsSync(targetPath)) {
    writeFileAtomically(targetPath, readFileSync(sourcePath, 'utf-8'), { mode: 0o600 })
  }
  return true
}
