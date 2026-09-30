import { stat } from 'node:fs/promises'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import type { GitWorktreeExecOptions } from '../worktree-operation-options'
import { readRepoConfigFacts, resolveRepoCommonDirFromFiles } from './repo-admin-layout'
import { WorktreeRowsNeedGit } from './worktree-membership-file-rows'
import { validateMembershipFromFiles } from './worktree-membership-file-validation'
import {
  describeMembershipParityMismatch,
  readGitWorktreeRows,
  validateMembershipFromGit
} from './worktree-membership-git-rows'
import {
  CLEAN_MEMBERSHIP_SCOPE,
  FULL_MEMBERSHIP_SCOPE,
  MEMBERSHIP_FULL_DERIVE_FLOOR_MS,
  type MembershipDirtyScope,
  type WorktreeMembershipModel
} from './worktree-membership-model'

// How a membership model is built (one Git baseline plus the parity check) and re-derived.

export function gitOptionsFor(options: GitWorktreeExecOptions): GitWorktreeExecOptions {
  // A shared derivation must not be cancelled by one caller's signal; callers race it instead.
  return {
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.timeout ? { timeout: options.timeout } : {}),
    ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
  }
}

function pinToGit(model: WorktreeMembershipModel, reason: string): void {
  model.source = { kind: 'git', reason }
  model.files = null
  console.warn(`[git/worktree-membership] using git worktree list for ${model.repoPath}: ${reason}`)
}

export async function createMembershipModel(
  key: string,
  repoPath: string,
  options: GitWorktreeExecOptions
): Promise<WorktreeMembershipModel | null> {
  const commonDir = await resolveRepoCommonDirFromFiles(repoPath, options.wslDistro).catch(
    () => null
  )
  if (!commonDir) {
    return null
  }
  const gitOptions = gitOptionsFor(options)
  const startedAt = Date.now()
  const facts = await readRepoConfigFacts(commonDir).catch(() => null)
  const gitOnlyReason = options.wslDistro
    ? 'WSL repo'
    : facts === null
      ? 'unreadable config'
      : facts.gitOnlyReason
  const model: WorktreeMembershipModel = {
    key,
    repoPath,
    wslDistro: options.wslDistro,
    commonDir,
    main: { path: repoPath, isBare: false },
    source: { kind: 'files' },
    files: null,
    git: { entryNames: null, listingStamp: null, signature: undefined },
    rows: [],
    validatedAt: startedAt,
    fullDerivedAt: startedAt,
    lastReadAt: startedAt,
    generation: 0,
    dirty: CLEAN_MEMBERSHIP_SCOPE,
    inFlight: new Map(),
    startedDerivations: 0,
    committedDerivation: 0
  }
  if (!gitOnlyReason && (await adoptFileRows(model, gitOptions))) {
    return model
  }
  if (gitOnlyReason) {
    model.source = { kind: 'git', reason: gitOnlyReason }
  }
  // Pinned, or a transient read failure: a files model with no memo retries files next read.
  const git = await validateMembershipFromGit({
    repoPath,
    commonDir,
    options: gitOptions,
    previous: model.git,
    previousRows: null,
    mustRun: true
  })
  model.git = git.state
  model.rows = git.rows
  if (gitOnlyReason) {
    model.main = { path: git.rows[0]?.path ?? repoPath, isBare: git.rows[0]?.isBare ?? false }
  }
  return model
}

/**
 * The model's one `git worktree list`: it supplies the main row (path spelling, bareness), and the
 * file rows must reproduce it exactly or the repo stays on Git for this process. A mismatch is
 * re-checked against a second listing first, so a worktree changing between the two reads cannot
 * pin a healthy repo.
 */
async function adoptFileRows(
  model: WorktreeMembershipModel,
  gitOptions: GitWorktreeExecOptions
): Promise<boolean> {
  let mismatch: string | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const baseline = await readGitWorktreeRows(model.repoPath, gitOptions, false)
    const gitMain = baseline.rows[0]
    if (!gitMain?.isMainWorktree) {
      pinToGit(model, 'git listed no main worktree')
      return false
    }
    model.main = { path: gitMain.path, isBare: gitMain.isBare }
    try {
      const derivedAt = Date.now()
      const derived = await validateMembershipFromFiles({
        commonDir: model.commonDir,
        main: model.main,
        previous: null,
        dirty: FULL_MEMBERSHIP_SCOPE,
        full: true
      })
      mismatch = describeMembershipParityMismatch(
        derived.rows,
        baseline.rows,
        baseline.nulDelimited
      )
      if (!mismatch) {
        model.files = derived.state
        model.rows = derived.rows
        model.validatedAt = derivedAt
        model.fullDerivedAt = derivedAt
        return true
      }
    } catch (error) {
      if (!(error instanceof WorktreeRowsNeedGit)) {
        throw error
      }
      if (!error.transient) {
        pinToGit(model, error.reason)
      }
      return false
    }
  }
  pinToGit(model, `file rows differ from git: ${mismatch}`)
  return false
}

export async function deriveMembershipModel(
  model: WorktreeMembershipModel,
  dirty: MembershipDirtyScope,
  options: GitWorktreeExecOptions,
  derivation: number,
  onCommonDirGone: () => void
): Promise<GitWorktreeInfo[]> {
  const startedAt = Date.now()
  const full = dirty.all || startedAt - model.fullDerivedAt >= MEMBERSHIP_FULL_DERIVE_FLOOR_MS
  // Only the newest derivation commits; an older one still answers its own callers.
  const commit = (rows: GitWorktreeInfo[], apply: () => void): GitWorktreeInfo[] => {
    if (derivation > model.committedDerivation) {
      model.committedDerivation = derivation
      apply()
      model.rows = rows
      model.validatedAt = startedAt
      if (full) {
        model.fullDerivedAt = startedAt
      }
    }
    return rows
  }
  if (
    !(await stat(model.commonDir).then(
      () => true,
      () => false
    ))
  ) {
    // The repo's Git dir is gone: drop the model so the next read re-resolves the layout, and let
    // Git give this read its answer (usually "not a git repository", a true empty).
    onCommonDirGone()
    return (await readGitWorktreeRows(model.repoPath, gitOptionsFor(options))).rows
  }
  if (model.source.kind === 'files') {
    try {
      const result = await validateMembershipFromFiles({
        commonDir: model.commonDir,
        main: model.main,
        previous: model.files,
        dirty,
        full
      })
      return commit(result.rows, () => {
        model.files = result.state
      })
    } catch (error) {
      if (!(error instanceof WorktreeRowsNeedGit)) {
        throw error
      }
      if (!error.transient) {
        pinToGit(model, error.reason)
      }
    }
  }
  const result = await validateMembershipFromGit({
    repoPath: model.repoPath,
    commonDir: model.commonDir,
    options: gitOptionsFor(options),
    previous: model.git,
    previousRows: model.source.kind === 'git' && model.git.signature ? model.rows : null,
    mustRun: full || dirty.listing
  })
  return commit(result.rows, () => {
    model.git = result.state
  })
}
