import { writeRollingFileBackup } from '../rolling-file-backup'
import { getTomlTable, parseCodexConfigToml } from './codex-config-toml-document'
import {
  assertCodexConfigTomlParses,
  clearCodexConfigTomlEditRefusalReport,
  CodexConfigTomlEditRefusedError,
  reportCodexConfigOnce,
  reportCodexConfigTomlEditRefusal
} from './codex-config-toml-checked-edit'
import { repairOrcaCodexConfigDuplicates } from './codex-config-toml-repair'
import { normalizeCodexProjectPathForLookup } from './config-toml-trust'
import {
  deduplicateProjectTomlSections,
  getTomlSectionHeaderKey,
  getTomlSections,
  isRuntimeProjectTomlSection,
  joinTomlBlocks
} from './config-toml-runtime-owned-sections'

/** True (and reported) when `content` is not TOML Codex could read, so the caller must not write it. */
export function refuseUnparseableManagedConfig(configPath: string, content: string): boolean {
  try {
    assertCodexConfigTomlParses(content)
    clearCodexConfigTomlEditRefusalReport(configPath)
    return false
  } catch (error) {
    if (!(error instanceof CodexConfigTomlEditRefusedError)) {
      throw error
    }
    reportCodexConfigTomlEditRefusal(
      error.forConfigPath(configPath),
      'Skipped writing a managed Codex config'
    )
    return true
  }
}

export function findManagedConfigRefusal(
  configPath: string,
  content: string
): CodexConfigTomlEditRefusedError | null {
  try {
    assertCodexConfigTomlParses(content)
    return null
  } catch (error) {
    if (error instanceof CodexConfigTomlEditRefusedError) {
      return error.forConfigPath(configPath)
    }
    throw error
  }
}

// Why (#22592): a ~/.codex Orca broke earlier must not carry its duplicates into
// every managed home; launch prep repairs the file itself on the next trust write.
export function repairUnparseableCodexConfig(config: string): string {
  return parseCodexConfigToml(config).ok ? config : repairOrcaCodexConfigDuplicates(config)
}

/** Project keys ~/.codex defines inline or with dotted keys rather than as `[projects."…"]` tables. */
export function getProjectsDefinedOutsideTables(config: string): ReadonlySet<string> {
  const parsed = parseCodexConfigToml(config)
  const projects = parsed.ok ? getTomlTable(parsed.table.projects) : null
  if (!projects) {
    return new Set()
  }
  const tableProjects = new Set(
    getTomlSections(config)
      .filter((section) => isRuntimeProjectTomlSection(section.header))
      .map((section) => getTomlSectionHeaderKey(section.header))
  )
  return new Set(
    Object.keys(projects)
      .map((projectPath) => `project:${normalizeCodexProjectPathForLookup(projectPath)}`)
      .filter((key) => !tableProjects.has(key))
  )
}

/** The parse error when Codex cannot read `config` even after Orca's own repair, else null. */
export function findUnparseableCodexConfig(config: string): string | null {
  const parsed = parseCodexConfigToml(repairUnparseableCodexConfig(config))
  if (parsed.ok) {
    return null
  }
  return parsed.line ? `line ${parsed.line}: ${parsed.message}` : parsed.message
}

/**
 * Why: an Orca-owned home broken only by Orca's own duplicate trust tables is
 * collapsed by the mirror's dedupe (#22592), so it still holds state worth
 * keeping; only a config that stays unreadable after that is treated as a copy
 * of a broken ~/.codex.
 */
export function findUnparseableManagedCodexConfig(config: string): string | null {
  const parseError = findUnparseableCodexConfig(config)
  if (parseError === null) {
    return null
  }
  const repaired = repairUnparseableCodexConfig(config)
  const sections = getTomlSections(repaired)
  const firstSectionLine = sections[0]?.start ?? -1
  const preamble =
    firstSectionLine === -1 ? repaired : repaired.split('\n').slice(0, firstSectionLine).join('\n')
  const deduplicated = joinTomlBlocks([
    preamble,
    ...deduplicateProjectTomlSections(sections).map((section) => section.block)
  ])
  return parseCodexConfigToml(deduplicated).ok ? null : parseError
}

const MIRROR_REFUSAL_TTL_MS = 10 * 60_000

type CodexMirrorRefusal = { sourcePath: string; detail: string; at: number }

const mirrorRefusals = new Map<string, CodexMirrorRefusal>()

/**
 * Why: ~/.codex saved mid-edit must not overwrite a managed home that still
 * holds state only it has (an unpromoted /model, an MCP server added in
 * Orca-launched Codex, trust answers). Kept per managed file, like launch trust
 * failures, so a later surface can show why syncing paused.
 */
export function refuseMirrorFromUnparseableSource(
  sourcePath: string,
  runtimeConfigPath: string,
  parseError: string,
  now = Date.now()
): void {
  const detail = `${sourcePath} is not valid TOML (${parseError}); left ${runtimeConfigPath} as it was. Fix ${sourcePath} to resume syncing.`
  mirrorRefusals.set(runtimeConfigPath, { sourcePath, detail, at: now })
  reportCodexConfigOnce(runtimeConfigPath, detail)
}

/**
 * Why: with nothing in the managed home to lose, an unchanged copy makes
 * Orca-launched Codex show Codex's own error, exactly like `codex` typed by hand.
 */
export function reportVerbatimUnparseableCodexSource(
  sourcePath: string,
  runtimeConfigPath: string,
  parseError: string,
  now = Date.now()
): void {
  const detail = `${sourcePath} is not valid TOML (${parseError}); copied it unchanged into ${runtimeConfigPath} so Orca-launched Codex reports the same error. Fix ${sourcePath} to resume syncing.`
  mirrorRefusals.set(runtimeConfigPath, { sourcePath, detail, at: now })
  reportCodexConfigOnce(runtimeConfigPath, detail)
}

export function clearCodexMirrorRefusal(runtimeConfigPath: string): void {
  mirrorRefusals.delete(runtimeConfigPath)
}

export function getRecentCodexMirrorRefusal(
  runtimeConfigPath: string,
  now = Date.now()
): string | null {
  const refusal = mirrorRefusals.get(runtimeConfigPath)
  return refusal && now - refusal.at <= MIRROR_REFUSAL_TTL_MS ? refusal.detail : null
}

/**
 * What the mirror does with a ~/.codex Codex cannot parse: leave a managed
 * config that parses untouched, or copy the source verbatim when the managed
 * home has nothing to lose. Null when the source parses.
 */
export function applyUnparseableCodexSourceRule(args: {
  sourcePath: string
  runtimeConfigPath: string
  source: string
  runtime: string | null
  writeVerbatimCopy: () => void
}): 'left-untouched' | 'copied' | null {
  const parseError = args.source.trim() === '' ? null : findUnparseableCodexConfig(args.source)
  if (parseError === null) {
    clearCodexMirrorRefusal(args.runtimeConfigPath)
    return null
  }
  if (args.runtime !== null && findUnparseableManagedCodexConfig(args.runtime) === null) {
    refuseMirrorFromUnparseableSource(args.sourcePath, args.runtimeConfigPath, parseError)
    return 'left-untouched'
  }
  reportVerbatimUnparseableCodexSource(args.sourcePath, args.runtimeConfigPath, parseError)
  if (args.runtime !== args.source) {
    args.writeVerbatimCopy()
  }
  return 'copied'
}

/**
 * Why: reseeding replaces a managed config Codex cannot parse; unless it is just
 * the verbatim copy of ~/.codex, keep it as `.bak` so its bytes are not lost silently.
 */
export function backUpDiscardedManagedConfig(args: {
  sourcePath: string
  runtimeConfigPath: string
  source: string
  discarded: string | null
}): void {
  if (
    args.discarded === null ||
    args.discarded === args.source ||
    findUnparseableManagedCodexConfig(args.discarded) === null
  ) {
    return
  }
  writeRollingFileBackup(args.runtimeConfigPath, `${args.runtimeConfigPath}.bak`)
  reportCodexConfigOnce(
    `${args.runtimeConfigPath}#discarded`,
    `${args.runtimeConfigPath} was not valid TOML; replaced it with a fresh copy of ${args.sourcePath} and kept the old file as ${args.runtimeConfigPath}.bak.`
  )
}
