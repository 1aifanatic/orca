import type { GitPushTarget } from './types'

/**
 * Where a worktree's starting content came from, stamped once when Orca creates it.
 * - `repo-ref`: a branch or ref of the user's own repository.
 * - `same-repo-review-head`: a PR head that lives in the same repository.
 * - `cross-repo-review-head`: a PR head from a fork, i.e. third-party content.
 * - `unverified-commit`: a raw commit whose repository Orca cannot vouch for.
 */
export type OrcaCreationContentOrigin =
  | 'repo-ref'
  | 'same-repo-review-head'
  | 'cross-repo-review-head'
  | 'unverified-commit'

const FULL_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

/**
 * Review-head creates start from the PR head commit. A same-repo head carries a push
 * target on an existing remote, while a fork's names the fork's URL; anything else
 * built from a bare commit cannot be attributed and is treated as third-party.
 */
export function classifyWorktreeContentOrigin(args: {
  baseBranch: string | undefined
  pushTarget: GitPushTarget | undefined
}): OrcaCreationContentOrigin {
  const base = args.baseBranch?.trim()
  if (!base || !FULL_COMMIT_SHA.test(base)) {
    return 'repo-ref'
  }
  if (!args.pushTarget) {
    return 'unverified-commit'
  }
  return args.pushTarget.remoteUrl ? 'cross-repo-review-head' : 'same-repo-review-head'
}

/** Content Orca may pre-trust for an agent: the user's own repository, never a fork's. */
export function isFirstPartyWorktreeContentOrigin(
  origin: OrcaCreationContentOrigin | undefined
): boolean {
  return origin === 'repo-ref' || origin === 'same-repo-review-head'
}
