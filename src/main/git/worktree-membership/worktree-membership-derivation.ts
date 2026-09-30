import { realpath, stat } from 'node:fs/promises'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { getErrorCode, type GitWorktreeExecOptions } from '../worktree-operation-options'
import { canonicalWorktreePath } from '../worktree-path-comparison'
import { readRepoConfigFacts, resolveRepoCommonDirFromFiles } from './repo-admin-layout'
import { WorktreeRowsNeedGit } from './worktree-membership-file-rows'
import { validateMembershipFromFiles } from './worktree-membership-file-validation'
import {
  describeMembershipParityMismatch,
  readGitWorktreeRows,
  validateMembershipFromGit
} from './worktree-membership-git-rows'
import {
  MEMBERSHIP_FULL_DERIVE_FLOOR_MS,
  type FileDerivationState,
  type MembershipDerivationStart,
  type WorktreeMembershipModel
} from './worktree-membership-model'

// How a membership model is built (one Git baseline plus the parity check) and re-derived. Native
// local repos only: WSL repos never get a model (a 9P stat can read an existing dir as absent).

/** The registered repo path no longer exists: the true empty answer, reached with one stat. */
export class MissingRepoPathError extends Error {
  readonly code = 'ENOENT'
  constructor(readonly repoPath: string) {
    super(`repo path missing: ${repoPath}`)
  }
}

async function assertRepoPathPresent(repoPath: string): Promise<void> {
  await stat(repoPath).catch((error: unknown) => {
    if (getErrorCode(error) === 'ENOENT') {
      throw new MissingRepoPathError(repoPath)
    }
  })
}

export function gitOptionsFor(options: GitWorktreeExecOptions): GitWorktreeExecOptions {
  // A shared derivation must not be cancelled by one caller's signal; callers race it instead.
  return {
    ...(options.timeout ? { timeout: options.timeout } : {}),
    ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
  }
}

function pinToGit(model: WorktreeMembershipModel, reason: string): void {
  model.source = { kind: 'git', reason }
  model.files = null
  console.warn(`[git/worktree-membership] using git worktree list for ${model.repoPath}: ${reason}`)
}

/** A model with nothing derived yet; the store registers it before its first build starts. */
export function createMembershipModelShell(
  key: string,
  repoPath: string,
  startedAt: number
): WorktreeMembershipModel {
  return {
    key,
    repoPath,
    commonDir: '',
    commonDirKey: '',
    main: { path: repoPath, isBare: false },
    source: { kind: 'files' },
    files: null,
    git: { entryNames: null, listingStamp: null, signature: undefined },
    rows: [],
    validated: { generation: 0, startedAt },
    fullDerivedAt: startedAt,
    lastReadAt: startedAt,
    generation: 0,
    listingOwed: false,
    building: null,
    inFlight: new Map(),
    startedDerivations: 0,
    committedDerivation: 0,
    stalledWork: 0
  }
}

/**
 * The model's first build, as generation 0's derivation. Resolves null when files cannot even
 * locate the repo's common dir; the caller then leaves the repo to Git.
 */
export async function buildMembershipModel(
  model: WorktreeMembershipModel,
  options: GitWorktreeExecOptions
): Promise<GitWorktreeInfo[] | null> {
  await assertRepoPathPresent(model.repoPath)
  const commonDir = await resolveRepoCommonDirFromFiles(model.repoPath).catch(() => null)
  if (!commonDir) {
    return null
  }
  model.commonDir = commonDir
  model.commonDirKey = canonicalWorktreePath(await realpath(commonDir).catch(() => commonDir))
  const gitOptions = gitOptionsFor(options)
  const facts = await readRepoConfigFacts(commonDir).catch(() => null)
  const gitOnlyReason = facts === null ? 'unreadable config' : facts.gitOnlyReason
  const adopted = gitOnlyReason ? null : await adoptFileRows(model, gitOptions)
  if (adopted) {
    model.main = adopted.main
    model.files = adopted.files
    model.rows = adopted.rows
    return model.rows
  }
  if (gitOnlyReason) {
    model.source = { kind: 'git', reason: gitOnlyReason }
  }
  // Pinned, or a transient read failure: a files model with no file state re-runs parity next read.
  const git = await validateMembershipFromGit({
    repoPath: model.repoPath,
    commonDir,
    options: gitOptions,
    previous: model.git,
    previousRows: null,
    mustRun: true
  })
  model.git = git.state
  model.rows = git.rows
  if (gitOnlyReason) {
    model.main = { path: git.rows[0]?.path ?? model.repoPath, isBare: git.rows[0]?.isBare ?? false }
  }
  return model.rows
}

type FileAdoption = {
  main: WorktreeMembershipModel['main']
  files: FileDerivationState
  rows: GitWorktreeInfo[]
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
): Promise<FileAdoption | null> {
  let mismatch: string | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const baseline = await readGitWorktreeRows(model.repoPath, gitOptions, false)
    const gitMain = baseline.rows[0]
    if (!gitMain?.isMainWorktree) {
      pinToGit(model, 'git listed no main worktree')
      return null
    }
    const main = { path: gitMain.path, isBare: gitMain.isBare }
    try {
      const derived = await validateMembershipFromFiles({
        commonDir: model.commonDir,
        main,
        previous: null,
        listingOwed: true,
        full: true
      })
      mismatch = describeMembershipParityMismatch(
        derived.rows,
        baseline.rows,
        baseline.nulDelimited
      )
      if (!mismatch) {
        return { main, files: derived.state, rows: derived.rows }
      }
    } catch (error) {
      if (!(error instanceof WorktreeRowsNeedGit)) {
        throw error
      }
      if (!error.transient) {
        pinToGit(model, error.reason)
      }
      return null
    }
  }
  pinToGit(model, `file rows differ from git: ${mismatch}`)
  return null
}

export async function deriveMembershipModel(
  model: WorktreeMembershipModel,
  start: MembershipDerivationStart & { listingOwed: boolean },
  options: GitWorktreeExecOptions,
  derivation: number,
  dropModel: () => void
): Promise<GitWorktreeInfo[]> {
  const { startedAt, listingOwed } = start
  const full = startedAt - model.fullDerivedAt >= MEMBERSHIP_FULL_DERIVE_FLOOR_MS
  // Only the newest derivation commits; an older one still answers its own callers. What it
  // records is when and at which generation it started, which is all reuse ever looks at.
  const commit = (
    rows: GitWorktreeInfo[],
    apply: () => void,
    fullDerive = full
  ): GitWorktreeInfo[] => {
    if (derivation > model.committedDerivation) {
      model.committedDerivation = derivation
      apply()
      model.rows = rows
      model.validated = { generation: start.generation, startedAt }
      if (fullDerive) {
        model.fullDerivedAt = startedAt
      }
    }
    return rows
  }
  try {
    await assertRepoPathPresent(model.repoPath)
  } catch (error) {
    dropModel()
    throw error
  }
  if (
    !(await stat(model.commonDir).then(
      () => true,
      () => false
    ))
  ) {
    // The repo's Git dir is gone: drop the model so the next read re-resolves the layout, and let
    // Git give this read its answer (usually "not a git repository", a true empty).
    dropModel()
    return (await readGitWorktreeRows(model.repoPath, gitOptionsFor(options))).rows
  }
  if (model.source.kind === 'files' && !model.files) {
    // A cold build that fell back on a transient read failure never compared file rows with Git.
    const adopted = await adoptFileRows(model, gitOptionsFor(options))
    if (adopted) {
      return commit(
        adopted.rows,
        () => {
          model.main = adopted.main
          model.files = adopted.files
        },
        true
      )
    }
  } else if (model.source.kind === 'files') {
    try {
      const result = await validateMembershipFromFiles({
        commonDir: model.commonDir,
        main: model.main,
        previous: model.files,
        listingOwed,
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
    mustRun: full || listingOwed
  })
  return commit(result.rows, () => {
    model.git = result.state
  })
}
