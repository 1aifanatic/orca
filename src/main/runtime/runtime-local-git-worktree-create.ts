import type { LocalGitExecOptions } from '../git/repo-default-base-ref'
import { runWorktreeChangeInvalidators } from '../ipc/worktree-change-invalidators'
import type { GitPushTarget, GitWorktreeInfo } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import { resolveCreatedWorktree } from '../ipc/created-worktree-reconciliation'
import { normalizeSparseDirectories } from '../ipc/sparse-checkout-directories'
import { configureCreatedWorktreePushTarget } from '../ipc/worktree-remote'
import {
  addSparseWorktree,
  addWorktree,
  type AddWorktreeOptions,
  type AddWorktreeResult
} from '../git/worktree'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { RemoteFetchResult, RemoteTrackingBase } from './runtime-remote-fetch-controller'
import { hasLocalWorktreeBaseRef } from '../git/worktree-base-ref-probe'
import { isGeneratedWorktreeCreateName } from '../worktree-create-candidates'
import {
  consumePreparedWorktreeCreate,
  type PreparationRearmHolder
} from '../worktree-create-preparation'
import {
  failedWorktreeCreationNeedsRetirement,
  retireGeneratedWorktreeName
} from '../worktree-name-retirement'
import type { WorktreeCreateTimingRecorder } from '../worktree-create-timing'

export type RuntimeLocalBaseRefRefresh = {
  /** Awaits the started refresh; returns the remote-tracking base the add should use. */
  finish: () => Promise<RemoteTrackingBase | null>
}

// Why: the base fetch doesn't depend on the chosen name, so start it before naming
// and await it after, as the desktop create does; naming's PR lookup overlaps it.
export async function startRuntimeLocalBaseRefRefresh(args: {
  repo: Repo
  baseBranch: string
  localWorktreeGitOptions: LocalGitExecOptions
  resolveRemoteTrackingBase: (
    repoPath: string,
    baseBranch: string,
    options?: LocalGitExecOptions
  ) => Promise<RemoteTrackingBase | null>
  hasRemoteTrackingRef: (
    repoPath: string,
    base: RemoteTrackingBase,
    options?: LocalGitExecOptions
  ) => Promise<boolean>
  refreshRemoteTrackingBase: (
    repoPath: string,
    base: RemoteTrackingBase,
    options?: LocalGitExecOptions
  ) => Promise<RemoteFetchResult>
  fetchRemote: (repoPath: string, remote: string, options?: LocalGitExecOptions) => Promise<void>
  timing: WorktreeCreateTimingRecorder
}): Promise<RuntimeLocalBaseRefRefresh> {
  const remoteTrackingBase = await args.resolveRemoteTrackingBase(
    args.repo.path,
    args.baseBranch,
    args.localWorktreeGitOptions
  )
  if (remoteTrackingBase) {
    const [hadRemoteRef, hasNamedLocalBaseRef] = await Promise.all([
      args.hasRemoteTrackingRef(args.repo.path, remoteTrackingBase, args.localWorktreeGitOptions),
      hasLocalWorktreeBaseRef(args.repo.path, args.baseBranch, args.localWorktreeGitOptions)
    ])
    const hasLocalBase = hadRemoteRef || hasNamedLocalBaseRef
    if (!hadRemoteRef && hasLocalBase) {
      return { finish: async () => null }
    }
    const refresh = args.refreshRemoteTrackingBase(
      args.repo.path,
      remoteTrackingBase,
      args.localWorktreeGitOptions
    )
    // Why: naming can throw before finish() awaits the refresh.
    void refresh.catch(() => undefined)
    return {
      finish: async () => {
        const result = await args.timing.time('refresh_base_ref', () => refresh)
        if (!result.ok && !hadRemoteRef) {
          throw new Error(
            `Could not refresh base ref "${args.baseBranch}" from "${remoteTrackingBase.remote}". Check your network and try again.`
          )
        }
        if (
          !hadRemoteRef &&
          !(await args.hasRemoteTrackingRef(
            args.repo.path,
            remoteTrackingBase,
            args.localWorktreeGitOptions
          ))
        ) {
          throw new Error(`Base ref "${args.baseBranch}" was not found after fetching.`)
        }
        return remoteTrackingBase
      }
    }
  }
  if (
    await hasLocalWorktreeBaseRef(args.repo.path, args.baseBranch, args.localWorktreeGitOptions)
  ) {
    return { finish: async () => null }
  }
  const originFetch = args.fetchRemote(args.repo.path, 'origin', args.localWorktreeGitOptions)
  void originFetch.catch(() => undefined)
  return {
    finish: async () => {
      try {
        await args.timing.time('refresh_base_ref', () => originFetch)
      } catch {}
      return null
    }
  }
}

export async function createRuntimeLocalGitWorktree(args: {
  request: RuntimeManagedWorktreeCreateArgs
  repo: Repo
  store: RuntimeStore
  settings: {
    workspaceDir: string
    nestWorkspaces: boolean
    refreshLocalBaseRefOnWorktreeCreate: boolean
    localBaseRefSuggestionDismissed?: boolean
  }
  baseBranch: string
  workspaceRoot: string
  branchName: string
  worktreePath: string
  effectiveSanitizedName?: string
  checkoutExistingBranch: boolean
  localWorktreeGitOptions: LocalGitExecOptions
  baseRefRefresh: RuntimeLocalBaseRefRefresh
  rearm: PreparationRearmHolder
  timing: WorktreeCreateTimingRecorder
}): Promise<{
  remoteTrackingBase: RemoteTrackingBase | null
  sparseDirectories: string[]
  configuredPushTarget?: GitPushTarget
  created: GitWorktreeInfo
  addResult: AddWorktreeResult
}> {
  const remoteTrackingBase = await args.baseRefRefresh.finish()
  const sparseDirectories = args.request.sparseCheckout
    ? normalizeSparseDirectories(args.request.sparseCheckout.directories)
    : []
  if (args.request.sparseCheckout && sparseDirectories.length === 0) {
    throw new Error('Sparse checkout requires at least one repo-relative directory.')
  }
  // Why: defer the remote add + fetch (fork case) or the redundant re-fetch
  // (same-repo case, already fetched while resolving the PR start point) to
  // first use -- push/pull/fetch/fast-forward materialize it on demand
  // (#17828). Metadata is persisted untouched; only the git mutation defers.
  const preparedPushTarget = args.request.pushTarget
  const suggestLocalBaseRefUpdate =
    !args.settings.refreshLocalBaseRefOnWorktreeCreate &&
    !args.settings.localBaseRefSuggestionDismissed &&
    Boolean(remoteTrackingBase)
  const remoteOption = remoteTrackingBase ? { remoteTrackingBase } : undefined
  const preparedWorktreeOptions: AddWorktreeOptions = {
    ...remoteOption,
    ...(suggestLocalBaseRefUpdate ? { suggestLocalBaseRefUpdate } : {}),
    ...args.localWorktreeGitOptions
  }
  const addOptions: AddWorktreeOptions = {
    ...preparedWorktreeOptions,
    ...(args.checkoutExistingBranch ? { checkoutExistingBranch: true } : {})
  }
  const shouldRetireGeneratedName =
    args.request.nameWasGenerated === true &&
    Boolean(args.effectiveSanitizedName) &&
    isGeneratedWorktreeCreateName(args.effectiveSanitizedName!)
  let addResult: AddWorktreeResult
  try {
    addResult = await args.timing.time('git_worktree_add', async () => {
      if (sparseDirectories.length > 0 || args.checkoutExistingBranch) {
        args.timing.recordPreparedCheckout({
          status: 'miss',
          reason: sparseDirectories.length > 0 ? 'sparse_checkout' : 'checkout_existing_branch'
        })
      } else {
        const preparedAttempt = await consumePreparedWorktreeCreate({
          repoPath: args.repo.path,
          workspaceRoot: args.workspaceRoot,
          worktreePath: args.worktreePath,
          branch: args.branchName,
          baseBranch: args.baseBranch,
          refreshLocalBaseRef: args.settings.refreshLocalBaseRefOnWorktreeCreate,
          options: preparedWorktreeOptions,
          timing: args.timing
        })
        if (preparedAttempt.status === 'hit') {
          // Deferred, not fired: re-arming is a full `reset --hard`, and the caller still has
          // materialization probes and terminals ahead of it.
          args.rearm.fire = preparedAttempt.rearm
          return preparedAttempt.result
        }
        if (preparedAttempt.rearm) {
          args.rearm.fire = preparedAttempt.rearm
        }
      }
      if (sparseDirectories.length > 0) {
        return (
          (await addSparseWorktree(
            args.repo.path,
            args.worktreePath,
            args.branchName,
            sparseDirectories,
            args.baseBranch,
            args.settings.refreshLocalBaseRefOnWorktreeCreate,
            addOptions
          )) ?? {}
        )
      }
      return (
        (await addWorktree(
          args.repo.path,
          args.worktreePath,
          args.branchName,
          args.baseBranch,
          args.settings.refreshLocalBaseRefOnWorktreeCreate,
          false,
          addOptions
        )) ?? {}
      )
    })
  } catch (error) {
    if (shouldRetireGeneratedName && failedWorktreeCreationNeedsRetirement(error)) {
      await retireGeneratedWorktreeName(
        args.store as Parameters<typeof retireGeneratedWorktreeName>[0],
        args.repo,
        args.settings,
        args.effectiveSanitizedName!
      )
    }
    throw error
  }
  // Why: the worktree is listable from here on; scans that began before it appeared are stale.
  runWorktreeChangeInvalidators(args.repo.id)
  if (shouldRetireGeneratedName) {
    await retireGeneratedWorktreeName(
      args.store as Parameters<typeof retireGeneratedWorktreeName>[0],
      args.repo,
      args.settings,
      args.effectiveSanitizedName!
    )
  }
  // Why: `--set-upstream-to` requires the remote to already exist -- safe for a
  // same-repo target (its remote, e.g. `origin`, always exists) but not for a
  // deferred fork remote, which is materialized lazily at first push/pull/fetch.
  const configuredPushTarget =
    preparedPushTarget && !preparedPushTarget.remoteUrl
      ? await configureCreatedWorktreePushTarget(
          args.worktreePath,
          args.branchName,
          preparedPushTarget,
          args.localWorktreeGitOptions
        )
      : preparedPushTarget
  const { created, worktrees, listingComplete } = await args.timing.time(
    'list_created_worktree',
    () =>
      resolveCreatedWorktree(
        args.repo.path,
        args.worktreePath,
        args.branchName,
        args.localWorktreeGitOptions
      )
  )
  if (listingComplete) {
    args.timing.recordWorktreeCount(worktrees.length)
  }
  return {
    remoteTrackingBase,
    sparseDirectories,
    ...(configuredPushTarget ? { configuredPushTarget } : {}),
    created,
    addResult
  }
}
