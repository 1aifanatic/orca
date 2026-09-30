import { stat } from 'node:fs/promises'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { resolveGitAdmissionTier } from '../command-runner/git-operation-executor'
import { readTranslatedWorktreeGraph } from '../worktree-list-reader'
import type { GitWorktreeExecOptions } from '../worktree-operation-options'
import { canonicalWorktreePath } from '../worktree-path-comparison'
import { createMembershipModel, deriveMembershipModel } from './worktree-membership-derivation'
import {
  CLEAN_MEMBERSHIP_SCOPE,
  isCleanMembershipScope,
  LISTING_MEMBERSHIP_SCOPE,
  MEMBERSHIP_IDLE_DROP_MS,
  MEMBERSHIP_READ_MEMO_MS,
  mergeMembershipScopes,
  type MembershipDirtyScope,
  type WorktreeMembershipModel
} from './worktree-membership-model'
import { getErrorCode } from '../worktree-operation-options'

// One worktree membership model per registered local repo, owned by the main process. Every
// listing reads it; it re-derives its own truth from disk by stat, so no watcher has to be alive
// for it to be right. Watcher events and Orca's own mutations only let a read skip the 1 s memo.

export type WorktreeMembershipReadOptions = GitWorktreeExecOptions & {
  /** Bypass the memo and any older in-flight derivation: for callers that must be right now. */
  fresh?: boolean
}

export type WorktreeMembershipRead = {
  rows: GitWorktreeInfo[]
  /** False when no model could be built for the layout and Git answered directly, unannotated. */
  fromModel: boolean
}

/** The registered repo path no longer exists: the true empty answer, reached with one stat. */
export class MissingRepoPathError extends Error {
  readonly code = 'ENOENT'
  constructor(readonly repoPath: string) {
    super(`repo path missing: ${repoPath}`)
  }
}

const models = new Map<string, WorktreeMembershipModel>()
const modelCreations = new Map<string, Promise<WorktreeMembershipModel | null>>()

function membershipKey(repoPath: string, wslDistro: string | undefined): string {
  return `${canonicalWorktreePath(repoPath)}\0${wslDistro?.trim().toLowerCase() ?? ''}`
}

function raceSignal<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return work
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function dropIdleModels(now: number): void {
  for (const [key, model] of models) {
    if (now - model.lastReadAt >= MEMBERSHIP_IDLE_DROP_MS) {
      models.delete(key)
    }
  }
}

function readModel(
  model: WorktreeMembershipModel,
  options: WorktreeMembershipReadOptions
): Promise<GitWorktreeInfo[]> {
  const now = Date.now()
  model.lastReadAt = now
  if (
    !options.fresh &&
    isCleanMembershipScope(model.dirty) &&
    now - model.validatedAt < MEMBERSHIP_READ_MEMO_MS
  ) {
    return Promise.resolve(model.rows)
  }
  // Why the tier: an interactive read joining a queued background derivation inherits its wait.
  const tier = resolveGitAdmissionTier(options.admissionTier)
  const joined = model.inFlight.get(tier)
  if (!options.fresh && joined && joined.generation === model.generation) {
    return joined.promise
  }
  const generation = model.generation
  const dirty = model.dirty
  model.dirty = CLEAN_MEMBERSHIP_SCOPE
  if (!isCleanMembershipScope(dirty)) {
    // The memo predates the change this derivation took; readers arriving meanwhile must join it.
    model.validatedAt = 0
  }
  const derivation = ++model.startedDerivations
  const promise = deriveMembershipModel(model, dirty, options, derivation, () => {
    models.delete(model.key)
  })
    .catch((error: unknown) => {
      // A failed derivation proved nothing; what it was asked to re-read is still owed.
      model.dirty = mergeMembershipScopes(model.dirty, dirty)
      throw error
    })
    .finally(() => {
      if (model.inFlight.get(tier)?.promise === promise) {
        model.inFlight.delete(tier)
      }
    })
  if (!options.fresh) {
    model.inFlight.set(tier, { generation, promise })
  }
  return promise
}

async function getOrCreateModel(
  key: string,
  repoPath: string,
  options: WorktreeMembershipReadOptions
): Promise<WorktreeMembershipModel | null> {
  const existing = models.get(key)
  if (existing) {
    return existing
  }
  let creation = modelCreations.get(key)
  if (!creation) {
    creation = createMembershipModel(key, repoPath, options)
      .then((model) => {
        if (model) {
          models.set(key, model)
        }
        return model
      })
      .finally(() => modelCreations.delete(key))
    modelCreations.set(key, creation)
  }
  return creation
}

/**
 * Every worktree Git would list for a local repo, main first, create preparations included.
 * Rejects when the listing failed; a missing native repo path rejects with MissingRepoPathError
 * after one stat and no Git.
 */
export async function readWorktreeMembership(
  repoPath: string,
  options: WorktreeMembershipReadOptions = {}
): Promise<WorktreeMembershipRead> {
  dropIdleModels(Date.now())
  const key = membershipKey(repoPath, options.wslDistro)
  // A WSL path can read as absent while its distro is stopped, which is not a deleted repo.
  if (!options.wslDistro) {
    await stat(repoPath).catch((error: unknown) => {
      if (getErrorCode(error) === 'ENOENT') {
        models.delete(key)
        throw new MissingRepoPathError(repoPath)
      }
    })
  }
  const model = await raceSignal(getOrCreateModel(key, repoPath, options), options.signal)
  if (!model) {
    return { rows: await readTranslatedWorktreeGraph(repoPath, options), fromModel: false }
  }
  return { rows: await raceSignal(readModel(model, options), options.signal), fromModel: true }
}

function markModels(
  matches: (model: WorktreeMembershipModel) => boolean,
  scope: MembershipDirtyScope
): void {
  for (const model of models.values()) {
    if (matches(model)) {
      model.generation += 1
      model.dirty = mergeMembershipScopes(model.dirty, scope)
    }
  }
}

/** Orca changed this repo's worktrees (add, remove, move, prune, unlock) or was told they changed. */
export function markWorktreeMembershipDirty(repoPath: string): void {
  const repoKey = canonicalWorktreePath(repoPath)
  markModels((model) => canonicalWorktreePath(model.repoPath) === repoKey, LISTING_MEMBERSHIP_SCOPE)
}

/** A watcher saw these admin entries of a Git common dir change. */
export function markWorktreeMembershipCommonDirDirty(
  commonDir: string,
  scope: MembershipDirtyScope
): void {
  const commonDirKey = canonicalWorktreePath(commonDir)
  markModels((model) => canonicalWorktreePath(model.commonDir) === commonDirKey, scope)
}

export function markAllWorktreeMembershipsDirty(): void {
  markModels(() => true, LISTING_MEMBERSHIP_SCOPE)
}

/** Drop models of repos no longer registered; the next read of a re-added repo rebuilds one. */
export function retainWorktreeMembershipModels(registeredRepoPaths: readonly string[]): void {
  const registered = new Set(registeredRepoPaths.map((path) => canonicalWorktreePath(path)))
  for (const [key, model] of models) {
    if (!registered.has(canonicalWorktreePath(model.repoPath))) {
      models.delete(key)
    }
  }
}

export function isWorktreeMembershipModelBacked(repoPath: string, wslDistro?: string): boolean {
  return models.has(membershipKey(repoPath, wslDistro))
}

export function _getWorktreeMembershipModelForTests(
  repoPath: string,
  wslDistro?: string
): WorktreeMembershipModel | undefined {
  return models.get(membershipKey(repoPath, wslDistro))
}

export function _resetWorktreeMembershipModelsForTests(): void {
  models.clear()
  modelCreations.clear()
}
