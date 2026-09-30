import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import type { AdminStatSignature } from './admin-stat-signature'
import type { RepoConfigFacts } from './repo-admin-layout'
import type { DerivedFileRow } from './worktree-membership-file-rows'

// A read inside this window returns the last derivation; past it, the read re-validates by stat.
export const MEMBERSHIP_READ_MEMO_MS = 1_000
// Covers a same-granule rewrite on a coarse-mtime disk (1 s HFS+, 2 s FAT) that no event reported.
export const MEMBERSHIP_FULL_DERIVE_FLOOR_MS = 5 * 60_000
export const MEMBERSHIP_IDLE_DROP_MS = 30 * 60_000

/** Which slice of a model a change may have moved; the shape the git-common watcher produces. */
export type MembershipDirtyScope = {
  all: boolean
  listing: boolean
  primary: boolean
  /** `headIdentityEntryKey`-folded admin entry names. */
  entryKeys: ReadonlySet<string>
}

export const CLEAN_MEMBERSHIP_SCOPE: MembershipDirtyScope = Object.freeze({
  all: false,
  listing: false,
  primary: false,
  entryKeys: new Set<string>()
})

export const LISTING_MEMBERSHIP_SCOPE: MembershipDirtyScope = Object.freeze({
  all: false,
  listing: true,
  primary: true,
  entryKeys: new Set<string>()
})

export const FULL_MEMBERSHIP_SCOPE: MembershipDirtyScope = Object.freeze({
  all: true,
  listing: true,
  primary: true,
  entryKeys: new Set<string>()
})

export function isCleanMembershipScope(scope: MembershipDirtyScope): boolean {
  return !scope.all && !scope.listing && !scope.primary && scope.entryKeys.size === 0
}

export function mergeMembershipScopes(
  first: MembershipDirtyScope,
  second: MembershipDirtyScope
): MembershipDirtyScope {
  if (isCleanMembershipScope(second)) {
    return first
  }
  if (isCleanMembershipScope(first)) {
    return second
  }
  return {
    all: first.all || second.all,
    listing: first.listing || second.listing,
    primary: first.primary || second.primary,
    entryKeys: new Set([...first.entryKeys, ...second.entryKeys])
  }
}

export type DerivedRowMemo = { derived: DerivedFileRow; signature: AdminStatSignature }

/** Everything the file rules derived, replaced as a unit when a derivation commits. */
export type FileDerivationState = {
  facts: RepoConfigFacts
  configStamp: string | null
  packedStamp: string | null
  packedRefs: Map<string, string> | null
  listingStamp: string | null
  entryNames: string[] | null
  entries: Map<string, DerivedRowMemo>
  main: DerivedRowMemo | null
}

/** Git-derived rows plus the stat signature that decides whether Git must run again. */
export type GitDerivationState = {
  entryNames: string[] | null
  listingStamp: string | null
  signature: AdminStatSignature | undefined
}

export type MembershipSource =
  | { kind: 'files' }
  /** Pinned for the model's lifetime; a rebuilt model (next launch, idle drop) re-tests. */
  | { kind: 'git'; reason: string }

export type WorktreeMembershipModel = {
  key: string
  repoPath: string
  wslDistro: string | undefined
  commonDir: string
  /** The common dir's realpath, compared form: how watchers and sibling repos name it. */
  commonDirKey: string
  /** Git's own main row path and bareness, from the model's one baseline listing. */
  main: { path: string; isBare: boolean }
  source: MembershipSource
  files: FileDerivationState | null
  git: GitDerivationState
  /** Every row, main first, create preparations included; callers filter. */
  rows: GitWorktreeInfo[]
  validatedAt: number
  /** The generation the committed rows' derivation started at; the memo needs it to be current. */
  validatedGeneration: number
  fullDerivedAt: number
  lastReadAt: number
  generation: number
  dirty: MembershipDirtyScope
  inFlight: Map<string, { generation: number; promise: Promise<GitWorktreeInfo[]> }>
  startedDerivations: number
  committedDerivation: number
  /** Derivations that outlived their deadline and have not settled; no new one starts meanwhile. */
  stalledDerivations: number
}
