import { mkdirSync, readFileSync } from 'node:fs'
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
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { writeFileAtomically, writeFileAtomicallyIfUnchanged } from './fs-utils'
import { carryMirrorOnlyHomeFiles } from './retired-mirror-home-files'

export const RETIRED_MIRROR_CARRY_MARKER = 'retired-mirror-carry-v1.json'

const CARRY_STEPS = ['settings', 'hooks', 'tables', 'credentials', 'files'] as const
type CarryStep = (typeof CARRY_STEPS)[number]

type RetiredMirrorHomes = {
  runtimeHomePath: string
  systemHomePath: string
}

/**
 * Carries what only the system-default mirror holds into ~/.codex when that
 * lane retires. Promotion salvages settings only inside a mirror pass, and the
 * mirror keeps project trust, its own MCP servers, pane logins, approved
 * command rules and pane-installed skills to itself, so without this the first
 * real-home launch would drop them.
 *
 * Additive: never replaces anything ~/.codex already has. The marker records
 * each step that landed, so a launch reruns only the ones still owed and a
 * landed step can never re-add what the user later removed. Returns whether
 * every step is done.
 */
export function carryRetiredMirror(
  homes: RetiredMirrorHomes,
  markerPath: string,
  carryCredentials: () => boolean
): boolean {
  const completed = readCompletedCarrySteps(markerPath)
  const pending = CARRY_STEPS.filter((step) => !completed.has(step))
  if (pending.length === 0) {
    return true
  }
  // Why: a fresh user may have no ~/.codex until Codex first runs there.
  mkdirSync(homes.systemHomePath, { recursive: true, mode: 0o700 })
  const steps: Record<CarryStep, () => boolean> = {
    settings: () => promoteCodexRuntimeSettingsToSystem(homes) !== null,
    hooks: () => promoteCodexRuntimeHookApprovalsToSystem(homes.runtimeHomePath),
    tables: () => carryMirrorOnlyTables(homes),
    credentials: carryCredentials,
    files: () => carryMirrorOnlyHomeFiles(homes)
  }
  const landed = pending.filter((step) => runStep(steps[step]))
  if (landed.length > 0) {
    const done = CARRY_STEPS.filter((step) => completed.has(step) || landed.includes(step))
    writeFileAtomically(markerPath, `${JSON.stringify({ completed: done })}\n`)
  }
  return landed.length === pending.length
}

function readCompletedCarrySteps(markerPath: string): ReadonlySet<CarryStep> {
  let contents: string
  try {
    contents = readFileSync(markerPath, 'utf-8')
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return new Set()
    }
    throw error
  }
  let marker: unknown
  try {
    marker = JSON.parse(contents)
  } catch {
    marker = null
  }
  if (
    marker &&
    typeof marker === 'object' &&
    'completed' in marker &&
    Array.isArray(marker.completed)
  ) {
    const completed: unknown[] = marker.completed
    return new Set(CARRY_STEPS.filter((step) => completed.includes(step)))
  }
  // Why all done: rerunning landed steps would bring back what the user removed since.
  console.warn('[codex-runtime-home] Unreadable retired-mirror carry marker; treating it as done')
  return new Set(CARRY_STEPS)
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
  // removed there stays gone, read exactly as promotion reads the baseline.
  // Projects have no such record, so one deleted from ~/.codex but still
  // trusted in the mirror's panes carries back.
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
