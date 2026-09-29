import { stripCodexDaemonOverride } from './codex-daemon-socket-path-guard'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlTableHeaderPath } from './config-toml-key-path'
import { parseStandardTableHeaderSegments } from './config-toml-syntax'
import {
  readTomlAssignmentValue,
  scanTomlStructure,
  tomlKeyPathsEqual
} from './codex-config-toml-structure'
import {
  normalizeCodexProjectPathForLookup,
  normalizeCodexProjectPathForRevocationLookup,
  parseCodexProjectHeaderPath
} from './config-toml-trust'

export type TomlSection = {
  header: string
  block: string
  start: number
}

export function stripRuntimeOwnedTomlSections(
  config: string,
  runtimeProjectHeaders = new Set<string>()
): string {
  const lines = config.split('\n')
  const sourceSections = getTomlSections(config)
  const sections = deduplicateProjectTomlSections(sourceSections)
  const firstSectionIndex = sourceSections[0]?.start ?? -1
  const preamble = firstSectionIndex === -1 ? config : lines.slice(0, firstSectionIndex).join('\n')
  return joinTomlBlocks([
    preamble,
    ...sections
      .filter((section) => !isRuntimeHookTrustTomlSection(section.header))
      .filter(
        (section) =>
          !isRuntimeProjectTomlSection(section.header) ||
          !runtimeProjectHeaders.has(getTomlSectionHeaderKey(section.header)) ||
          getProjectTrustLevel(section.block) === 'untrusted'
      )
      .map((section) => section.block)
  ])
}

export function getTomlSections(config: string): TomlSection[] {
  const lines = config.split('\n')
  const sections: TomlSection[] = []
  let sectionStart = -1
  let sectionHeader: string | null = null
  let scanState = createTomlLineScanState()

  for (let index = 0; index < lines.length; index += 1) {
    const header = isTomlStructuralLine(scanState) ? getTomlTableHeader(lines[index] ?? '') : null
    if (!header) {
      scanState = updateTomlLineScanState(scanState, lines[index] ?? '')
      continue
    }

    if (sectionStart !== -1) {
      sections.push({
        header: sectionHeader ?? '',
        block: lines.slice(sectionStart, index).join('\n'),
        start: sectionStart
      })
    }
    sectionStart = index
    sectionHeader = header
    scanState = updateTomlLineScanState(scanState, lines[index] ?? '')
  }

  if (sectionStart !== -1) {
    sections.push({
      header: sectionHeader ?? '',
      block: lines.slice(sectionStart).join('\n'),
      start: sectionStart
    })
  }
  return sections
}

export function isRuntimePreservedTomlSection(header: string): boolean {
  return isRuntimeHookTrustTomlSection(header) || isRuntimeProjectTomlSection(header)
}

export function isRuntimeHookTrustTomlSection(header: string): boolean {
  const segments = parseStandardTableHeaderSegments(header)
  // Why: Codex's config writer materializes the parent table on Windows. It is
  // part of runtime-owned trust and must survive the next config mirror too.
  return (
    segments !== null &&
    (segments.length === 2 || segments.length === 3) &&
    segments[0] === 'hooks' &&
    segments[1] === 'state'
  )
}

export function isRuntimeProjectTomlSection(header: string): boolean {
  return parseCodexProjectHeaderPath(header) !== null
}

const CODEX_MCP_SERVER_TABLE_ROOT = 'mcp_servers'

/** Returns the decoded MCP server name for an owner table or nested descendant. */
export function getMcpServerTomlSectionName(header: string): string | null {
  const table = parseTomlTableHeaderPath(header)
  if (!table || table.isArray || table.segments[0] !== CODEX_MCP_SERVER_TABLE_ROOT) {
    return null
  }
  return table.segments[1] ?? null
}

export function getTomlSectionHeaderKey(header: string): string {
  const projectPath = parseCodexProjectHeaderPath(header)
  return projectPath === null
    ? getDecodedTomlSectionIdentity(header)
    : `project:${normalizeCodexProjectPathForLookup(projectPath)}`
}

// Why (#22592): spellings of one table share one identity, as they do for Codex.
function getDecodedTomlSectionIdentity(header: string): string {
  const table = parseTomlTableHeaderPath(header)
  return table
    ? `${table.isArray ? 'array' : 'table'}:${JSON.stringify(table.segments)}`
    : header.trim()
}

// Why: configs written before WSL tails compared case-sensitively can hold a
// revocation under drifted casing; match it loosely so trust is not resurrected.
export function getRevocationTomlSectionHeaderKey(header: string): string {
  const projectPath = parseCodexProjectHeaderPath(header)
  return projectPath === null
    ? getDecodedTomlSectionIdentity(header)
    : `project:${normalizeCodexProjectPathForRevocationLookup(projectPath)}`
}

// Why: hook upsert already removes both quote representations, while its paired
// Windows slash variants are required for Codex 0.140 and must remain distinct.
export function deduplicateProjectTomlSections(sections: TomlSection[]): TomlSection[] {
  const deduplicated: TomlSection[] = []
  const projectIndexes = new Map<string, number>()
  const hookTrustIdentities = new Set<string>()
  for (const section of sections) {
    if (isRuntimeHookTrustTomlSection(section.header)) {
      // Why: two definitions of one hooks.state table make the whole file unreadable to Codex.
      const identity = getDecodedTomlSectionIdentity(section.header)
      if (!hookTrustIdentities.has(identity)) {
        hookTrustIdentities.add(identity)
        deduplicated.push(section)
      }
      continue
    }
    if (!isRuntimeProjectTomlSection(section.header)) {
      deduplicated.push(section)
      continue
    }
    const key = getTomlSectionHeaderKey(section.header)
    const existingIndex = projectIndexes.get(key)
    if (existingIndex === undefined) {
      projectIndexes.set(key, deduplicated.length)
      deduplicated.push(section)
      continue
    }
    const existing = deduplicated[existingIndex]
    if (
      existing &&
      getProjectTrustLevel(existing.block) !== 'untrusted' &&
      getProjectTrustLevel(section.block) === 'untrusted'
    ) {
      // Why: revocation must survive self-healing regardless of duplicate order.
      deduplicated[existingIndex] = section
    }
  }
  return deduplicated
}

export function getProjectTrustLevel(block: string): 'trusted' | 'untrusted' | null {
  for (const line of scanTomlStructure(block)) {
    if (line.kind === 'assignment' && tomlKeyPathsEqual(line.keySegments, ['trust_level'])) {
      const value = readTomlAssignmentValue(line)
      if (value === 'trusted' || value === 'untrusted') {
        return value
      }
    }
  }
  return null
}

export function joinTomlBlocks(blocks: string[]): string {
  const normalizedBlocks = blocks.map((block) => block.trim()).filter((block) => block.length > 0)
  return normalizedBlocks.length === 0 ? '' : `${normalizedBlocks.join('\n\n')}\n`
}

// Why: with no ~/.codex/config.toml the runtime config is the user's only
// config, so promotion seeds ~/.codex from it. Trust is runtime-owned and the
// mirror re-appends it, so drop every project and hook-trust table here.
export function extractOrdinaryCodexSettings(config: string): string {
  const sections = deduplicateProjectTomlSections(getTomlSections(config))
  const projectHeaders = new Set(
    sections
      .filter((section) => isRuntimeProjectTomlSection(section.header))
      .map((section) => getTomlSectionHeaderKey(section.header))
  )
  // Why: the daemon override exists only because Orca's home path is long; ~/.codex is not.
  return stripCodexDaemonOverride(stripRuntimeOwnedTomlSections(config, projectHeaders)).trimEnd()
}
