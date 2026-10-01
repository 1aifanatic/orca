import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  getMcpServerTomlSectionName,
  getRevocationTomlSectionHeaderKey,
  getTomlSectionHeaderKey,
  getTomlSections,
  isRuntimeProjectTomlSection,
  joinTomlBlocks
} from '../codex/config-toml-runtime-owned-sections'
import { writeFileAtomically, writeFileAtomicallyIfUnchanged } from './fs-utils'

export const RETIRED_MIRROR_CARRY_MARKER = 'retired-mirror-carry-v1.json'

// Why these files: Codex writes them into CODEX_HOME at login (auth.json) and
// at MCP OAuth (.credentials.json), so a login done inside an Orca pane lives
// only in the mirror until something copies it out.
const CREDENTIAL_FILES = ['auth.json', '.credentials.json']

type RetiredMirrorCarryOptions = {
  runtimeHomePath: string
  systemHomePath: string
  metadataDir: string
  /** False when the mirror's auth belongs to a managed account, not the system default. */
  mirrorAuthOwnedBySystemDefault: boolean
}

/**
 * Carries what only the system-default mirror holds into ~/.codex, once, when
 * that lane retires. Promotion salvages settings only as part of a mirror pass,
 * and the mirror keeps project trust, mirror-only MCP servers and credentials
 * for itself, so without this the first real-home launch would lose them.
 *
 * Additive: it never replaces anything ~/.codex already has. The marker lands
 * only after every step succeeded, so a failure retries on the next launch.
 */
export function carryRetiredSystemDefaultMirror(options: RetiredMirrorCarryOptions): void {
  const markerPath = join(options.metadataDir, RETIRED_MIRROR_CARRY_MARKER)
  if (existsSync(markerPath) || !existsSync(options.runtimeHomePath)) {
    return
  }
  try {
    if (!promoteCodexRuntimeSettingsToSystem(options)) {
      return
    }
    promoteCodexRuntimeHookApprovalsToSystem(options.runtimeHomePath)
    if (!carryMirrorOnlyConfigTables(options.runtimeHomePath, options.systemHomePath)) {
      return
    }
    if (options.mirrorAuthOwnedBySystemDefault) {
      for (const file of CREDENTIAL_FILES) {
        copyIfAbsent(join(options.runtimeHomePath, file), join(options.systemHomePath, file))
      }
    }
    writeFileSync(markerPath, `${JSON.stringify({ carriedAt: Date.now() })}\n`, 'utf-8')
  } catch (error) {
    console.warn('[codex-runtime-home] Failed to carry the retired mirror into ~/.codex:', error)
  }
}

/** Returns false when ~/.codex/config.toml changed underneath, so the carry retries. */
function carryMirrorOnlyConfigTables(runtimeHomePath: string, systemHomePath: string): boolean {
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
  const blocks = selectMirrorOnlyTables(
    runtimeObservation.value,
    systemConfig ?? '',
    readCodexSettingsBaseline(runtimeHomePath)
  )
  if (blocks.length === 0) {
    return true
  }
  return writeFileAtomicallyIfUnchanged(
    writeTarget.path,
    systemConfig,
    joinTomlBlocks([systemConfig ?? '', ...blocks]),
    { mode: writeTarget.mode }
  )
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

function copyIfAbsent(sourcePath: string, targetPath: string): void {
  if (!existsSync(sourcePath) || existsSync(targetPath)) {
    return
  }
  // Why 0700/0600: both files hold tokens.
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 })
  writeFileAtomically(targetPath, readFileSync(sourcePath, 'utf-8'), { mode: 0o600 })
}
