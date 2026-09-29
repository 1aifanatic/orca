import type { GitPushTarget } from './types'

/**
 * Where a worktree's starting content came from, stamped once when Orca creates it.
 * - `repo-ref`: a branch or ref of the user's own repository.
 * - `same-repo-review-head`: a PR head that lives in the same repository.
 * - `cross-repo-review-head`: a PR head from a fork, i.e. third-party content.
 * - `unverified-commit`: content whose repository Orca cannot vouch for.
 */
export type OrcaCreationContentOrigin =
  | 'repo-ref'
  | 'same-repo-review-head'
  | 'cross-repo-review-head'
  | 'unverified-commit'

const FULL_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

/**
 * Reads Orca's fork-remote markers (`remote.<name>.orca-created`) and which remote each
 * local branch tracks. Why the core key: it is always set, so a successful read never
 * exits 1 for "no match" and any failure means the config could not be read.
 */
export const ORCA_FORK_REMOTE_CONFIG_ARGS = [
  'config',
  '--local',
  '--get-regexp',
  '^(core\\.repositoryformatversion|remote\\..+\\.orca-created|branch\\..+\\.remote)$'
]

/** A named base (not a bare commit) must be checked against Orca's fork remotes. */
export function isNamedWorktreeBase(baseBranch: string | undefined): boolean {
  const base = baseBranch?.trim()
  return Boolean(base) && !FULL_COMMIT_SHA.test(base ?? '')
}

/** Whether `base` is a fork remote's ref Orca added for a PR, or a local branch tracking one. */
export function isBaseOnOrcaForkRemote(base: string, forkRemoteConfig: string): boolean {
  const forkRemotes = new Set<string>()
  const branchRemotes = new Map<string, string>()
  for (const line of forkRemoteConfig.split('\n')) {
    const [key = '', value = ''] = line.trim().split(' ', 2)
    if (key.startsWith('remote.') && key.endsWith('.orca-created') && value === 'true') {
      forkRemotes.add(key.slice('remote.'.length, -'.orca-created'.length))
    } else if (key.startsWith('branch.') && key.endsWith('.remote')) {
      branchRemotes.set(key.slice('branch.'.length, -'.remote'.length), value)
    }
  }
  const remoteRef = base.replace(/^(?:refs\/)?remotes\//, '')
  const localBranch = base.replace(/^refs\/heads\//, '')
  return (
    [...forkRemotes].some((remote) => remoteRef.startsWith(`${remote}/`)) ||
    forkRemotes.has(branchRemotes.get(localBranch) ?? '')
  )
}

/**
 * Review-head creates start from the PR head commit. A same-repo head carries a push
 * target on an existing remote, while a fork's names the fork's URL; anything else
 * built from a bare commit cannot be attributed and is treated as third-party. A named
 * base is checked against `forkRemoteConfig`; null means it could not be read.
 */
export function classifyWorktreeContentOrigin(args: {
  baseBranch: string | undefined
  pushTarget: GitPushTarget | undefined
  forkRemoteConfig: string | null
}): OrcaCreationContentOrigin {
  const base = args.baseBranch?.trim()
  if (!base) {
    return 'repo-ref'
  }
  if (isNamedWorktreeBase(base)) {
    if (args.forkRemoteConfig === null) {
      return 'unverified-commit'
    }
    return isBaseOnOrcaForkRemote(base, args.forkRemoteConfig)
      ? 'cross-repo-review-head'
      : 'repo-ref'
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
