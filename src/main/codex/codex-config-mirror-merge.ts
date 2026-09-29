import { readMcpServerTomlOwnership } from './config-toml-mcp-servers'
import {
  getProjectsDefinedOutsideTables,
  repairUnparseableCodexConfig
} from './codex-managed-config-validity'
import {
  deduplicateProjectTomlSections,
  getMcpServerTomlSectionName,
  getProjectTrustLevel,
  getRevocationTomlSectionHeaderKey,
  getTomlSectionHeaderKey,
  getTomlSections,
  isRuntimePreservedTomlSection,
  isRuntimeProjectTomlSection,
  joinTomlBlocks,
  stripRuntimeOwnedTomlSections
} from './config-toml-runtime-owned-sections'

/** Ordinary settings from ~/.codex plus the trust and MCP tables the managed home owns. */
export function mergeSystemCodexConfigIntoRuntime(
  runtimeConfig: string,
  systemConfig: string,
  mirroredMcpServerNames: ReadonlySet<string> = new Set(),
  mirroredMcpServerRoot = false
): string {
  const systemInlineProjects = getProjectsDefinedOutsideTables(systemConfig)
  const runtimeSections = deduplicateProjectTomlSections(
    getTomlSections(repairUnparseableCodexConfig(runtimeConfig))
  ).filter(
    // Why: ~/.codex defines this project inline or with dotted keys, so a
    // runtime `[projects."…"]` table beside it would redefine it.
    (section) =>
      !isRuntimeProjectTomlSection(section.header) ||
      !systemInlineProjects.has(getTomlSectionHeaderKey(section.header))
  )
  const runtimeProjectHeaders = new Set(
    runtimeSections
      .filter((section) => isRuntimeProjectTomlSection(section.header))
      .map((section) => getTomlSectionHeaderKey(section.header))
  )
  const systemProjectSections = deduplicateProjectTomlSections(
    getTomlSections(systemConfig)
  ).filter((section) => isRuntimeProjectTomlSection(section.header))
  const systemUntrustedProjectHeaders = new Set(
    systemProjectSections
      .filter((section) => getProjectTrustLevel(section.block) === 'untrusted')
      .map((section) => getRevocationTomlSectionHeaderKey(section.header))
  )
  // Why: an exact-cased trusted entry in ~/.codex is the user's latest explicit
  // decision for that exact project; a loosely-matched (case-drifted) revocation
  // must not override it, or re-granting trust would be reverted every mirror.
  const systemTrustedProjectHeaders = new Set(
    systemProjectSections
      .filter((section) => getProjectTrustLevel(section.block) === 'trusted')
      .map((section) => getTomlSectionHeaderKey(section.header))
  )
  const systemMcpServers = readMcpServerTomlOwnership(systemConfig)
  // Why: ordinary Codex settings should mirror ~/.codex exactly; runtime hook
  // trust and project trust are written under Orca's managed CODEX_HOME and
  // must survive the copy unless the user explicitly revoked project trust in
  // the system config.
  return joinTomlBlocks([
    stripRuntimeOwnedTomlSections(systemConfig, runtimeProjectHeaders),
    ...runtimeSections
      .filter((section) => {
        if (isRuntimePreservedTomlSection(section.header)) {
          return true
        }
        const mcpServerName = getMcpServerTomlSectionName(section.header)
        return (
          mcpServerName !== null &&
          !systemMcpServers.ownsRoot &&
          !mirroredMcpServerRoot &&
          !systemMcpServers.names.has(mcpServerName) &&
          !mirroredMcpServerNames.has(mcpServerName)
        )
      })
      .filter(
        (section) =>
          !isRuntimeProjectTomlSection(section.header) ||
          !systemUntrustedProjectHeaders.has(getRevocationTomlSectionHeaderKey(section.header)) ||
          systemTrustedProjectHeaders.has(getTomlSectionHeaderKey(section.header))
      )
      .map((section) => section.block)
  ])
}
