import type {
  PersistedOpenFile,
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'

type DraftFact = {
  worktreeId: string
  filePath: string
  runtimeEnvironmentId: string | null
  dirtyDraftContent: string
  lastKnownDiskSignature: string | undefined
}

export type ObsoleteDocumentDraftMerge = {
  merged: WorkspaceSessionState
  changed: boolean
  /** Drafts whose file row the current session no longer has; never merged, never dropped silently. */
  absentDrafts: number
}

function collectDraftFacts(payload: WorkspaceSessionPatch): DraftFact[] {
  const facts: DraftFact[] = []
  for (const [worktreeId, rows] of Object.entries(payload.openFilesByWorktree ?? {})) {
    for (const row of rows ?? []) {
      // Why `!== undefined`: an empty-string draft is still unsaved text the user typed.
      if (row?.dirtyDraftContent !== undefined && row.readOnly !== true) {
        facts.push({
          worktreeId,
          filePath: row.filePath,
          runtimeEnvironmentId: row.runtimeEnvironmentId?.trim() || null,
          dirtyDraftContent: row.dirtyDraftContent,
          lastKnownDiskSignature: row.lastKnownDiskSignature
        })
      }
    }
  }
  return facts
}

function isSameFileRow(row: PersistedOpenFile, fact: DraftFact): boolean {
  return (
    row.filePath === fact.filePath &&
    (row.runtimeEnvironmentId?.trim() || null) === fact.runtimeEnvironmentId
  )
}

/**
 * Takes only unsaved-draft facts from an obsolete window document and writes them onto the
 * matching rows of the CURRENT session. Nothing else is copied (no rows, wrappers, groups or
 * focus), and a clean row never clears a draft, so the merge can only add data.
 */
export function mergeObsoleteDocumentDrafts(
  current: WorkspaceSessionState,
  payload: WorkspaceSessionPatch
): ObsoleteDocumentDraftMerge {
  let openFilesByWorktree = current.openFilesByWorktree
  let changed = false
  let absentDrafts = 0
  for (const fact of collectDraftFacts(payload)) {
    const rows = openFilesByWorktree?.[fact.worktreeId] ?? []
    const index = rows.findIndex((row) => isSameFileRow(row, fact))
    if (index === -1) {
      absentDrafts += 1
      continue
    }
    const row = rows[index]!
    if (row.readOnly === true) {
      continue
    }
    if (
      row.dirtyDraftContent === fact.dirtyDraftContent &&
      row.lastKnownDiskSignature === fact.lastKnownDiskSignature
    ) {
      continue
    }
    // Why together: a draft and its disk baseline are one provenance pair; never mix generations.
    const { lastKnownDiskSignature: _previousSignature, ...rest } = row
    const nextRow: PersistedOpenFile = {
      ...rest,
      dirtyDraftContent: fact.dirtyDraftContent,
      ...(fact.lastKnownDiskSignature !== undefined
        ? { lastKnownDiskSignature: fact.lastKnownDiskSignature }
        : {})
    }
    openFilesByWorktree = {
      ...openFilesByWorktree,
      [fact.worktreeId]: rows.map((candidate, rowIndex) =>
        rowIndex === index ? nextRow : candidate
      )
    }
    changed = true
  }
  return {
    merged: changed ? { ...current, openFilesByWorktree } : current,
    changed,
    absentDrafts
  }
}
