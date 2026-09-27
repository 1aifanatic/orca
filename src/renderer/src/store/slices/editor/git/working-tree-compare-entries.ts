import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'

/** Fold index and working-tree paths onto the branch's merge-base paths. */
export function getWorkingTreeCompareEntries(
  branchEntries: readonly GitBranchChangeEntry[],
  statusEntries: readonly GitStatusEntry[]
): GitBranchChangeEntry[] {
  const entries = new Map(
    branchEntries.map((entry) => [entry.path, { ...entry, added: undefined, removed: undefined }])
  )
  const ordered = [...statusEntries].sort(
    (a, b) => Number(a.area !== 'staged') - Number(b.area !== 'staged')
  )
  for (const entry of ordered) {
    if (entry.conflictStatus === 'unresolved') {
      continue
    }
    const previous = entries.get(entry.oldPath ?? entry.path) ?? entries.get(entry.path)
    const oldPath = previous?.oldPath ?? entry.oldPath
    if (entry.status === 'renamed' && entry.oldPath) {
      entries.delete(entry.oldPath)
    }
    entries.set(entry.path, {
      path: entry.path,
      oldPath,
      status:
        entry.status === 'deleted'
          ? 'deleted'
          : previous?.status === 'added'
            ? 'added'
            : oldPath
              ? 'renamed'
              : entry.status === 'untracked'
                ? 'added'
                : entry.status,
      added: undefined,
      removed: undefined
    })
  }
  for (const entry of statusEntries) {
    if (entry.conflictStatus === 'unresolved') {
      entries.delete(entry.path)
      if (entry.oldPath) {
        entries.delete(entry.oldPath)
      }
    }
  }
  return [...entries.values()]
}

/** Counts bound automatic loading; they are not the net diff's displayed totals. */
export function getWorkingTreeCompareLineCounts(
  branchEntries: readonly GitBranchChangeEntry[],
  statusEntries: readonly GitStatusEntry[]
): Record<string, { added: number; removed: number }> {
  const counts = new Map<string, { added: number; removed: number } | undefined>()
  const ordered = [...statusEntries].sort(
    (a, b) => Number(a.area !== 'staged') - Number(b.area !== 'staged')
  )
  for (const entry of [...branchEntries, ...ordered]) {
    const path = entry.oldPath ?? entry.path
    const previous = counts.get(path)
    const known =
      entry.added !== undefined &&
      entry.removed !== undefined &&
      (!counts.has(path) || previous !== undefined)
    counts.set(
      entry.path,
      known
        ? {
            added: (previous?.added ?? 0) + entry.added!,
            removed: (previous?.removed ?? 0) + entry.removed!
          }
        : undefined
    )
  }
  return Object.fromEntries([...counts].flatMap(([path, count]) => (count ? [[path, count]] : [])))
}
