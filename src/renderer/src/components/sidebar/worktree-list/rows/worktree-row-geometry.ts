import type { WorktreeGroupBy } from '../grouping/row-types'
import {
  getFolderBackedRepoWorktreeCardContentIndent,
  getFolderBackedRepoWorktreeCardSurfaceInset,
  getLineageNestedRowGeometry,
  getWorktreeCardContentIndent,
  getWorktreeCardSurfaceInset
} from './indentation'

export function getWorktreeRowGeometry(args: {
  groupBy: WorktreeGroupBy
  folderBackedProjectGroupIds: ReadonlySet<string>
  newCardStyle: boolean
  projectGroupId: string | null | undefined
  depth: number
  groupDepth: number
  nested: boolean
}): { surfaceInset: number; cardContentIndent: number; lineageChildrenInlineOffset?: number } {
  const { groupBy, projectGroupId, depth, groupDepth, nested } = args
  const isFolderBackedRepoChild =
    groupBy === 'repo' &&
    Boolean(projectGroupId && args.folderBackedProjectGroupIds.has(projectGroupId))
  // Why: experimental in-card lineage inherits the parent surface; legacy cards keep depth-based nested geometry.
  const paddingDepth = nested ? Math.max(0, depth - 1) : depth
  const getCardContentIndent = (lineageDepth: number): number =>
    isFolderBackedRepoChild
      ? getFolderBackedRepoWorktreeCardContentIndent({
          groupDepth,
          lineageDepth
        })
      : getWorktreeCardContentIndent({
          isGrouped: groupBy !== 'none',
          groupDepth,
          lineageDepth
        })
  const nestedLineageGeometry = nested
    ? getLineageNestedRowGeometry({
        experimentalNewWorktreeCardStyle: args.newCardStyle,
        inheritedCardContentIndent: getCardContentIndent(0),
        lineageDepth: depth
      })
    : null
  // Why: grouped rows inherit their header depth, but the card surface still spans the full row.
  const paddingLeft =
    nested && groupBy !== 'none'
      ? getWorktreeCardContentIndent({
          isGrouped: false,
          groupDepth,
          lineageDepth: paddingDepth
        })
      : getCardContentIndent(paddingDepth)
  const surfaceInset = nestedLineageGeometry
    ? nestedLineageGeometry.surfaceInset
    : isFolderBackedRepoChild
      ? getFolderBackedRepoWorktreeCardSurfaceInset({
          groupDepth,
          lineageDepth: paddingDepth
        })
      : getWorktreeCardSurfaceInset({
          isGrouped: groupBy !== 'none',
          groupDepth
        })
  return {
    surfaceInset,
    cardContentIndent: nestedLineageGeometry
      ? nestedLineageGeometry.cardContentIndent
      : Math.max(0, paddingLeft - surfaceInset),
    lineageChildrenInlineOffset: nestedLineageGeometry?.lineageChildrenInlineOffset
  }
}
