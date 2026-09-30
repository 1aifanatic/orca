import {
  omitTomlPaths,
  parseCodexConfigToml,
  readTomlValueAtPath,
  tomlValuesEqual,
  type TomlKeyPath,
  type TomlTable
} from './codex-config-toml-document'
import {
  removedValuesSurviveIn,
  repairOrcaCodexConfigDuplicatesWithRemovals,
  repairUnparseableCodexConfig
} from './codex-config-toml-repair'
import type { TomlAssignmentLine } from './codex-config-toml-structure'

export type CodexConfigTomlEditRefusalReason =
  | 'input-invalid'
  | 'result-invalid'
  | 'unrelated-change'
  | 'intended-value-missing'
  | 'unsupported-form'

/** Orca declined to write a Codex config.toml because the edit could not be proven safe. */
export class CodexConfigTomlEditRefusedError extends Error {
  readonly reason: CodexConfigTomlEditRefusalReason
  readonly detail: string
  readonly line: number | null
  readonly configPath: string | null

  constructor(args: {
    reason: CodexConfigTomlEditRefusalReason
    detail: string
    line?: number | null
    configPath?: string | null
  }) {
    const where = args.configPath ?? 'Codex config.toml'
    const at = args.line ? ` (line ${args.line})` : ''
    super(`Orca left ${where} unchanged${at}: ${args.detail}`)
    this.name = 'CodexConfigTomlEditRefusedError'
    this.reason = args.reason
    this.detail = args.detail
    this.line = args.line ?? null
    this.configPath = args.configPath ?? null
  }

  forConfigPath(configPath: string): CodexConfigTomlEditRefusedError {
    return new CodexConfigTomlEditRefusedError({
      reason: this.reason,
      detail: this.detail,
      line: this.line,
      configPath
    })
  }
}

export type CodexConfigTomlEditResult = {
  content: string
  /** Paths the edit owns; every other parsed value must be unchanged. */
  ownedPaths: readonly TomlKeyPath[]
  /** Values the result must hold afterwards; `undefined` means the path must be absent. */
  expected?: readonly { path: TomlKeyPath; value: unknown }[]
}

export type CodexConfigTomlEdit = (
  content: string,
  table: TomlTable | null
) => CodexConfigTomlEditResult

export type CheckedCodexConfigTomlEditOptions = {
  /**
   * The edit replaces every definition of its owned paths, so it may run on a
   * file that is invalid only because of duplicates it collapses. Returns the
   * content with those definitions removed, which must parse and is what the
   * "changes nothing else" check compares against.
   */
  collapsesOwnedDuplicates?: (content: string) => string
}

/**
 * Runs a text-level edit and returns its result only if Codex could read it:
 * the result parses, holds the intended values, and leaves every other value
 * as it was. A file Orca broke earlier is repaired first; anything else is refused.
 */
export function applyCheckedCodexConfigTomlEdit(
  existingContent: string,
  edit: CodexConfigTomlEdit,
  options: CheckedCodexConfigTomlEditOptions = {}
): string {
  const before = parseCodexConfigToml(existingContent)
  let input = existingContent
  let inputTable: TomlTable | null = before.ok ? before.table : null
  let comparisonTable = inputTable
  let unverifiedRemovals: readonly TomlAssignmentLine[] = []
  if (!before.ok) {
    const repair = repairOrcaCodexConfigDuplicatesWithRemovals(existingContent)
    input = repair.content
    const repaired = parseCodexConfigToml(input)
    const withoutOwned =
      !repaired.ok && options.collapsesOwnedDuplicates
        ? parseCodexConfigToml(options.collapsesOwnedDuplicates(input))
        : null
    if (repaired.ok) {
      inputTable = repaired.table
      comparisonTable = repaired.table
    } else if (withoutOwned?.ok) {
      comparisonTable = withoutOwned.table
      unverifiedRemovals = repair.unverifiedRemovals
    } else {
      throw new CodexConfigTomlEditRefusedError({
        reason: 'input-invalid',
        detail: `the file is not valid TOML (${before.message}). Fix it so Codex can read it; Orca never edits a config Codex cannot parse.`,
        line: before.line
      })
    }
  }
  const result = edit(input, inputTable)
  if (result.content === existingContent) {
    return existingContent
  }
  const after = parseCodexConfigToml(result.content)
  if (!after.ok) {
    throw new CodexConfigTomlEditRefusedError({
      reason: 'result-invalid',
      detail: `the edit would have produced invalid TOML (${after.message}).`,
      line: after.line
    })
  }
  for (const { path, value } of result.expected ?? []) {
    if (!tomlValuesEqual(readTomlValueAtPath(after.table, path), value)) {
      throw new CodexConfigTomlEditRefusedError({
        reason: 'intended-value-missing',
        detail: `the edit would not have set ${path.join('.')} as intended.`
      })
    }
  }
  if (
    comparisonTable &&
    !removedValuesSurviveIn(comparisonTable, unverifiedRemovals, result.ownedPaths)
  ) {
    throw new CodexConfigTomlEditRefusedError({
      reason: 'input-invalid',
      detail: 'repairing duplicate tables would have removed a value that is defined nowhere else.'
    })
  }
  if (
    comparisonTable &&
    !tomlValuesEqual(
      omitTomlPaths(comparisonTable, result.ownedPaths),
      omitTomlPaths(after.table, result.ownedPaths)
    )
  ) {
    throw new CodexConfigTomlEditRefusedError({
      reason: 'unrelated-change',
      detail: 'the edit would have changed settings it does not own.'
    })
  }
  return result.content
}

/** For whole-document writers: the result must at least parse. */
export function assertCodexConfigTomlParses(content: string): void {
  const parsed = parseCodexConfigToml(content)
  if (!parsed.ok) {
    throw new CodexConfigTomlEditRefusedError({
      reason: 'result-invalid',
      detail: `the result would not be valid TOML (${parsed.message}).`,
      line: parsed.line
    })
  }
}

/**
 * For whole-document producers (the managed-home mirrors): true, and reported
 * once, when `result` does not parse although every input does after Orca's own
 * repair. An input the user broke by hand is mirrored as it is.
 */
export function refuseUnreadableCodexConfigResult(args: {
  configPath: string
  result: string
  inputs: readonly (string | null)[]
  context: string
}): boolean {
  const parsed = parseCodexConfigToml(args.result)
  if (
    parsed.ok ||
    args.inputs.some(
      (input) => input !== null && !parseCodexConfigToml(repairUnparseableCodexConfig(input)).ok
    )
  ) {
    clearCodexConfigTomlEditRefusalReport(args.configPath)
    return false
  }
  reportCodexConfigTomlEditRefusal(
    new CodexConfigTomlEditRefusedError({
      reason: 'result-invalid',
      detail: `the result would not be valid TOML (${parsed.message}).`,
      line: parsed.line,
      configPath: args.configPath
    }),
    args.context
  )
  return true
}

// Keyed by file, then by what Orca was doing, so interleaved reports about one file each log once.
const reportedMessages = new Map<string, Map<string, string>>()
const TRUST_WRITE_CONTEXT = 'Skipped marking a workspace trusted for Codex'
const HOOK_TRUST_WRITE_CONTEXT = 'Skipped writing Codex hook trust'
const TRUST_WRITE_KINDS: ReadonlySet<string> = new Set([
  TRUST_WRITE_CONTEXT,
  HOOK_TRUST_WRITE_CONTEXT
])

/** Logs once per file, kind, and message, so a launch-time retry does not flood the log. */
function reportCodexConfigOnce(key: string, message: string, kind = ''): void {
  let byKind = reportedMessages.get(key)
  if (!byKind) {
    byKind = new Map()
    reportedMessages.set(key, byKind)
  }
  if (byKind.get(kind) === message) {
    return
  }
  byKind.set(kind, message)
  console.warn(`[codex-config] ${message}`)
}

export function reportCodexConfigTomlEditRefusal(
  error: CodexConfigTomlEditRefusedError,
  context: string
): void {
  reportCodexConfigOnce(error.configPath ?? context, `${context}: ${error.message}`, context)
}

/**
 * Why: a refused trust write recurs on every launch until the user fixes the
 * file, so it is reported once per file; returns the other failures for the caller.
 */
export function reportCodexTrustWriteRefusals(error: unknown): unknown[] {
  return reportTrustWriteRefusals(error, TRUST_WRITE_CONTEXT)
}

export function reportCodexHookTrustWriteRefusals(error: unknown): unknown[] {
  return reportTrustWriteRefusals(error, HOOK_TRUST_WRITE_CONTEXT)
}

function reportTrustWriteRefusals(error: unknown, context: string): unknown[] {
  const failures = error instanceof AggregateError ? error.errors : [error]
  return failures.filter((failure) => {
    if (!(failure instanceof CodexConfigTomlEditRefusedError)) {
      return true
    }
    reportCodexConfigTomlEditRefusal(failure, context)
    return false
  })
}

/** Forgets mirror/write reports for a file; a trust refusal is only forgotten by a trust write that succeeds. */
export function clearCodexConfigTomlEditRefusalReport(configPath: string): void {
  const byKind = reportedMessages.get(configPath)
  for (const kind of byKind?.keys() ?? []) {
    if (!TRUST_WRITE_KINDS.has(kind)) {
      byKind?.delete(kind)
    }
  }
}

export function clearCodexTrustWriteRefusalReport(configPath: string): void {
  for (const kind of TRUST_WRITE_KINDS) {
    reportedMessages.get(configPath)?.delete(kind)
  }
}
