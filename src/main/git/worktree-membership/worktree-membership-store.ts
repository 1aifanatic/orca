import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { resolveGitAdmissionTier } from '../command-runner/git-operation-executor'
import { readTranslatedWorktreeGraph } from '../worktree-list-reader'
import {
  WORKTREE_LIST_TIMEOUT_MS,
  type GitWorktreeExecOptions
} from '../worktree-operation-options'
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

export { MissingRepoPathError } from './worktree-membership-derivation'

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

/** The model's file reads outlived the caller's deadline, as a hung mount does; Git's own
 *  timeout fails a listing the same way. */
export class WorktreeMembershipTimeoutError extends Error {
  readonly code = 'ETIMEDOUT'
  constructor(repoPath: string) {
    super(`worktree membership read timed out: ${repoPath}`)
  }
}

type MembershipMark = {
  matches: (model: WorktreeMembershipModel) => boolean
  scope: MembershipDirtyScope
}

const models = new Map<string, WorktreeMembershipModel>()
// Marks that land while a model is being built are replayed onto it, or its memo would hide them.
const modelCreations = new Map<
  string,
  { promise: Promise<WorktreeMembershipModel | null>; marks: MembershipMark[] }
>()

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

/**
 * Rejects once `timeoutMs` passes; the work keeps running and still settles. Why: fs reads have no
 * deadline of their own, and on a hung mount they would hold every waiting read forever.
 */
function boundByDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), timeoutMs)
    work.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

function readTimeoutMs(options: WorktreeMembershipReadOptions): number {
  return options.timeout ?? WORKTREE_LIST_TIMEOUT_MS
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
    model.validatedGeneration === model.generation &&
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
  // Another fs derivation behind a stalled one would only pin one more threadpool thread.
  if (model.stalledDerivations > 0) {
    return Promise.reject(new WorktreeMembershipTimeoutError(model.repoPath))
  }
  const generation = model.generation
  const dirty = model.dirty
  model.dirty = CLEAN_MEMBERSHIP_SCOPE
  const derivation = ++model.startedDerivations
  const work = deriveMembershipModel(model, dirty, options, derivation, () => {
    if (models.get(model.key) === model) {
      models.delete(model.key)
    }
  }).catch((error: unknown) => {
    // A failed derivation proved nothing; what it was asked to re-read is still owed.
    model.dirty = mergeMembershipScopes(model.dirty, dirty)
    throw error
  })
  const promise = boundByDeadline(work, readTimeoutMs(options), () => {
    model.stalledDerivations += 1
    void work
      .catch(() => {})
      .finally(() => {
        model.stalledDerivations -= 1
      })
    return new WorktreeMembershipTimeoutError(model.repoPath)
  }).finally(() => {
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
  const pending = modelCreations.get(key)
  if (pending) {
    return pending.promise
  }
  const marks: MembershipMark[] = []
  const work = createMembershipModel(key, repoPath, options)
    .then((model) => {
      if (model) {
        for (const mark of marks) {
          if (mark.matches(model)) {
            markModel(model, mark.scope)
          }
        }
        models.set(key, model)
      }
      return model
    })
    .finally(() => modelCreations.delete(key))
  // A build past its deadline stays registered until it settles, so later reads join its
  // rejection instead of starting another build on the same hung mount.
  const promise = boundByDeadline(
    work,
    readTimeoutMs(options),
    () => new WorktreeMembershipTimeoutError(repoPath)
  )
  modelCreations.set(key, { promise, marks })
  return promise
}

/**
 * Every worktree Git would list for a local repo, main first, create preparations included.
 * Rejects when the listing failed or outlived `options.timeout`; a missing native repo path
 * rejects with MissingRepoPathError after one stat and no Git.
 */
export async function readWorktreeMembership(
  repoPath: string,
  options: WorktreeMembershipReadOptions = {}
): Promise<WorktreeMembershipRead> {
  dropIdleModels(Date.now())
  const key = membershipKey(repoPath, options.wslDistro)
  const model = await raceSignal(getOrCreateModel(key, repoPath, options), options.signal)
  if (!model) {
    return { rows: await readTranslatedWorktreeGraph(repoPath, options), fromModel: false }
  }
  return { rows: await raceSignal(readModel(model, options), options.signal), fromModel: true }
}

function markModel(model: WorktreeMembershipModel, scope: MembershipDirtyScope): void {
  model.generation += 1
  model.dirty = mergeMembershipScopes(model.dirty, scope)
}

function markModels(
  matches: (model: WorktreeMembershipModel) => boolean,
  scope: MembershipDirtyScope
): void {
  for (const model of models.values()) {
    if (matches(model)) {
      markModel(model, scope)
    }
  }
  for (const creation of modelCreations.values()) {
    creation.marks.push({ matches, scope })
  }
}

/** Orca changed this repo's worktrees (add, remove, move, prune, unlock) or was told they changed. */
export function markWorktreeMembershipDirty(repoPath: string): void {
  const repoKey = canonicalWorktreePath(repoPath)
  const isRepo = (model: WorktreeMembershipModel): boolean =>
    canonicalWorktreePath(model.repoPath) === repoKey
  // Registered repos that share this repo's common dir share its worktrees.
  const commonDirKeys = new Set(
    [...models.values()].filter(isRepo).map((model) => model.commonDirKey)
  )
  markModels(
    (model) => isRepo(model) || commonDirKeys.has(model.commonDirKey),
    LISTING_MEMBERSHIP_SCOPE
  )
}

/** A watcher saw these admin entries of a Git common dir change. */
export function markWorktreeMembershipCommonDirDirty(
  commonDir: string,
  scope: MembershipDirtyScope
): void {
  // Watchers name the common dir by its realpath; a repo registered through a symlink does not.
  const commonDirKey = canonicalWorktreePath(commonDir)
  markModels(
    (model) =>
      model.commonDirKey === commonDirKey ||
      canonicalWorktreePath(model.commonDir) === commonDirKey,
    scope
  )
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
