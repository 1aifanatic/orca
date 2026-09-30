import { parseTomlTableHeaderPath } from './config-toml-key-path'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { findProjectTrustLevelEntries } from './config-toml-project-trust-level'
import { escapeTomlBasicString } from './config-toml-syntax'

type TomlTable = {
  /** Line index of the header; the body runs to the next table's header. */
  headerLine: number
  endLine: number
  header: string
  segments: string[] | null
  isArray: boolean
}

const ORCA_TRUST_LINE = 'trust_level = "trusted"'
const loggedRefusals = new Set<string>()

/**
 * Removes the duplicates older Orca builds wrote beside a Codex-spelled project
 * table (#22592): an appended `[projects."<p>"]` table holding only
 * `trust_level = "trusted"`, or that line inserted under a quoted `"trust_level"`.
 * The user's table always wins; anything else leaves the content untouched.
 */
export function repairOrcaDuplicateProjectTrust(content: string): string {
  const lines = content.split('\n')
  const tables = readTomlTables(lines)
  const removedLines = new Set<number>()
  const firstTableByPath = new Map<string, TomlTable>()
  for (const table of tables) {
    const projectPath = getProjectPath(table)
    if (projectPath === null) {
      continue
    }
    const first = firstTableByPath.get(projectPath)
    if (!first) {
      firstTableByPath.set(projectPath, table)
      const insertedLine = findOrcaInsertedTrustLine(lines, table)
      if (insertedLine === 'unsafe') {
        return refuseRepair(content, `duplicate trust_level for ${projectPath}`)
      }
      if (insertedLine !== null) {
        removedLines.add(insertedLine)
      }
      continue
    }
    if (!isOrcaAppendedTable(lines, table, projectPath) || first.header === table.header) {
      return refuseRepair(content, `duplicate project table for ${projectPath}`)
    }
    for (let index = table.headerLine; index < table.endLine; index += 1) {
      removedLines.add(index)
    }
  }
  if (removedLines.size === 0) {
    return content
  }
  const kept = lines.filter((_, index) => !removedLines.has(index)).join('\n')
  const repaired = content.endsWith('\n') && !kept.endsWith('\n') ? `${kept}\n` : kept
  // Why: a partial repair would still fail Codex's parse, so only write a file it can load.
  const remainingDuplicate = findDuplicateTable(repaired)
  return remainingDuplicate === null
    ? repaired
    : refuseRepair(content, `duplicate table ${remainingDuplicate} remains`)
}

function readTomlTables(lines: string[]): TomlTable[] {
  const tables: TomlTable[] = []
  let scanState = createTomlLineScanState()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const header = isTomlStructuralLine(scanState) ? getTomlTableHeader(line) : null
    scanState = updateTomlLineScanState(scanState, line)
    if (header === null) {
      continue
    }
    const previous = tables.at(-1)
    if (previous) {
      previous.endLine = index
    }
    const parsed = parseTomlTableHeaderPath(header)
    tables.push({
      headerLine: index,
      endLine: lines.length,
      header: header.trim(),
      segments: parsed?.segments ?? null,
      isArray: parsed?.isArray ?? false
    })
  }
  return tables
}

function getProjectPath(table: TomlTable): string | null {
  const segments = table.segments
  return !table.isArray && segments?.length === 2 && segments[0] === 'projects'
    ? (segments[1] ?? null)
    : null
}

function isOrcaAppendedTable(lines: string[], table: TomlTable, projectPath: string): boolean {
  if (stripCr(lines[table.headerLine]) !== `[projects."${escapeTomlBasicString(projectPath)}"]`) {
    return false
  }
  const body = lines.slice(table.headerLine + 1, table.endLine).map(stripCr)
  const content = body.filter((line) => line.trim() !== '')
  return content.length === 1 && content[0] === ORCA_TRUST_LINE
}

// Why: older Orca inserted its bare line directly under the header when it missed a quoted key.
function findOrcaInsertedTrustLine(lines: string[], table: TomlTable): number | 'unsafe' | null {
  const body = lines.slice(table.headerLine + 1, table.endLine).join('\n')
  const entries = findProjectTrustLevelEntries(body)
  if (entries.length < 2) {
    return null
  }
  const [inserted, ...others] = entries
  const isOrcaInsert =
    inserted?.start === 0 &&
    inserted.line === ORCA_TRUST_LINE &&
    others.length === 1 &&
    !/^[ \t]*trust_level/.test(others[0]?.line ?? '')
  return isOrcaInsert ? table.headerLine + 1 : 'unsafe'
}

function findDuplicateTable(content: string): string | null {
  const lines = content.split('\n')
  const seen = new Set<string>()
  for (const table of readTomlTables(lines)) {
    if (!table.segments || table.isArray) {
      continue
    }
    const key = JSON.stringify(table.segments)
    const body = lines.slice(table.headerLine + 1, table.endLine).join('\n')
    if (
      seen.has(key) ||
      (getProjectPath(table) !== null && findProjectTrustLevelEntries(body).length > 1)
    ) {
      return table.header
    }
    seen.add(key)
  }
  return null
}

function refuseRepair(content: string, reason: string): string {
  if (!loggedRefusals.has(reason)) {
    loggedRefusals.add(reason)
    console.warn(`[codex-config] Left a duplicate in config.toml unrepaired: ${reason}`)
  }
  return content
}

function stripCr(line: string | undefined): string {
  return (line ?? '').replace(/\r$/, '')
}
