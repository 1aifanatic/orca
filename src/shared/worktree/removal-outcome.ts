import type { WorktreeCatalogVersion } from './catalog-version'
import type { PreservedWorktreeBranch } from './create-types'

/** How a background worktree removal ended, published once on the worktrees-changed event. */
export type WorktreeRemovalOutcome =
  | {
      worktreeId: string
      status: 'removed'
      preservedBranch?: PreservedWorktreeBranch
      /** The catalog the finished removal produced. */
      catalogVersion?: WorktreeCatalogVersion
    }
  | { worktreeId: string; status: 'failed'; error: string }
