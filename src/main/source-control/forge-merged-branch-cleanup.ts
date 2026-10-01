import type { HostedReviewInfo } from '../../shared/hosted-review'
import type { Repo } from '../../shared/repo-types'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { deletePreservedBranchAtHead } from '../git/worktree'
import { getMergeRequestVersionHeadShas } from '../gitlab/merge-request-versions'
import {
  cleanupUnusedWorktreePushTargetRemote,
  cleanupUnusedWorktreePushTargetRemoteSsh
} from '../ipc/worktree-remote'
import type { WorktreePushTargetStore } from '../ipc/worktree-push-target-cleanup'
import type { Store } from '../persistence'
import { resolveWorktreeRemovalMetadata } from '../worktree-removal-repo-owner'
import {
  withRepoGhAccount,
  type LocalProjectWorktreeGitOptions
} from '../project-runtime-git-options'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import { getHostedReviewForBranch } from './hosted-review'
import {
  getRepoHostedReviewExecutionHostId,
  hostedReviewSshConnectionId
} from './hosted-review-execution-host'

/** One forge round trip per kept branch; past this the branch is kept and the delete finishes. */
export const FORGE_MERGED_LOOKUP_TIMEOUT_MS = 10_000

export type PreservedBranchForgeSettlement = {
  /** True only when the review host shows `head` belongs to a merged review. */
  confirmMergedAtHead: (branchName: string, head: string) => Promise<boolean>
  /** Deletes the branch only while it still points at `head`. */
  deleteAtHead: (branchName: string, head: string) => Promise<void>
}

/**
 * After `branch -d` kept a removed worktree's branch: delete it at its exact head when its review
 * host says that head was merged, else keep it for the "branch kept" toast. Runs after the
 * removal's watcher gate is released, outside the per-repo branch-delete queue, so a batch's
 * lookups overlap. Never throws: any failure keeps the branch.
 */
export async function settlePreservedBranchWithForge(
  result: RemoveWorktreeResult,
  { confirmMergedAtHead, deleteAtHead }: PreservedBranchForgeSettlement
): Promise<RemoveWorktreeResult> {
  const preserved = result.preservedBranch
  if (!preserved?.head) {
    return result
  }
  const { branchName, head } = preserved
  const confirmed = await withTimeout(
    confirmMergedAtHead(branchName, head).catch((error: unknown) => {
      console.warn(
        `[worktrees] Could not ask the review host whether "${branchName}" merged`,
        error
      )
      return false
    }),
    FORGE_MERGED_LOOKUP_TIMEOUT_MS,
    false
  )
  if (!confirmed) {
    return result
  }
  try {
    await deleteAtHead(branchName, head)
  } catch (error) {
    console.warn(`[worktrees] Kept merged branch "${branchName}": deleting it failed`, error)
    return result
  }
  const { preservedBranch: _deleted, ...rest } = result
  return rest
}

type LinkedReviewIds = Pick<
  WorktreeMeta,
  'linkedPR' | 'linkedGitLabMR' | 'linkedBitbucketPR' | 'linkedAzureDevOpsPR' | 'linkedGiteaPR'
>

type SettlementRepo = Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId' | 'ghAccount'>

type KeptBranchRemoval = {
  result: RemoveWorktreeResult
  repo: SettlementRepo
  worktreeId: string
  pushTarget: GitPushTarget | undefined
  store: WorktreePushTargetStore & Pick<Store, 'getRepos' | 'getWorktreeMeta'>
}

/**
 * Local and WSL removals: settle a kept branch with the review host, then drop the push-target
 * remote. One call so that cleanup, which keeps a remote a local branch still tracks, always runs
 * after the delete.
 */
export async function settleKeptBranch(
  removal: KeptBranchRemoval & { localGitOptions: LocalProjectWorktreeGitOptions }
): Promise<RemoveWorktreeResult> {
  const { repo, localGitOptions } = removal
  const result = await settlePreservedBranchWithForge(removal.result, {
    confirmMergedAtHead: forgeMergedAtHeadCheck({
      repo,
      localGitOptions,
      linkedReviews: removedWorktreeMeta(removal)
    }),
    // Why the queue: it serializes this repo's removal ref writes on `packed-refs.lock`.
    deleteAtHead: (branchName, head) =>
      deletePreservedBranchAtHead(repo.path, branchName, head, localGitOptions)
  })
  await cleanupUnusedWorktreePushTargetRemote(
    repo.path,
    removal.worktreeId,
    removal.pushTarget,
    removal.store,
    localGitOptions
  )
  return result
}

/** SSH removals: the review host is asked from here; the guarded delete runs on the remote. */
export async function settleKeptSshBranch(
  removal: KeptBranchRemoval & { provider: SshGitProvider }
): Promise<RemoveWorktreeResult> {
  const { repo, provider } = removal
  const result = await settlePreservedBranchWithForge(removal.result, {
    confirmMergedAtHead: forgeMergedAtHeadCheck({
      repo,
      localGitOptions: {},
      linkedReviews: removedWorktreeMeta(removal)
    }),
    deleteAtHead: (branchName, head) =>
      provider.forceDeletePreservedBranch(repo.path, branchName, head)
  })
  await cleanupUnusedWorktreePushTargetRemoteSsh(
    provider,
    repo.path,
    removal.worktreeId,
    removal.pushTarget,
    removal.store
  )
  return result
}

// Why the repo's host: a registered removal runs on the host that owns the repo row.
function removedWorktreeMeta({ store, repo, worktreeId }: KeptBranchRemoval) {
  return resolveWorktreeRemovalMetadata(
    store,
    repo.id,
    worktreeId,
    getRepoHostedReviewExecutionHostId(repo)
  )
}

/** Builds `confirmMergedAtHead` from what a removal caller already holds. */
export function forgeMergedAtHeadCheck({
  repo,
  localGitOptions,
  linkedReviews
}: {
  repo: SettlementRepo
  localGitOptions: LocalProjectWorktreeGitOptions
  linkedReviews: LinkedReviewIds | undefined
}): (branchName: string, head: string) => Promise<boolean> {
  return async (branchName, head) => {
    const executionHostId = getRepoHostedReviewExecutionHostId(repo)
    const localGitExecOptions = withRepoGhAccount(repo, localGitOptions)
    const review = await getHostedReviewForBranch({
      repoPath: repo.path,
      executionHostId,
      branch: branchName,
      linkedGitHubPR: linkedReviews?.linkedPR ?? null,
      linkedGitLabMR: linkedReviews?.linkedGitLabMR ?? null,
      linkedBitbucketPR: linkedReviews?.linkedBitbucketPR ?? null,
      linkedAzureDevOpsPR: linkedReviews?.linkedAzureDevOpsPR ?? null,
      linkedGiteaPR: linkedReviews?.linkedGiteaPR ?? null,
      // Why: GitHub then also confirms a head that is one of the PR's earlier commits.
      currentHeadOid: head,
      localGitExecOptions
    })
    if (review?.state !== 'merged') {
      return false
    }
    if (isReviewHead(review, head) || review.confirmedContainedHeadOid === head) {
      return true
    }
    if (review.provider !== 'gitlab') {
      return false
    }
    // Why: a GitLab suggestion or rebase moves the MR head past the local one; any pushed version counts.
    const versionHeads = await getMergeRequestVersionHeadShas(
      repo.path,
      review.number,
      hostedReviewSshConnectionId(executionHostId),
      { localGitExecOptions }
    )
    return versionHeads.includes(head)
  }
}

const BITBUCKET_SHORT_HASH = /^[0-9a-f]{12,}$/i

function isReviewHead(review: HostedReviewInfo, head: string): boolean {
  const reviewHead = review.headSha
  if (!reviewHead) {
    return false
  }
  if (reviewHead === head) {
    return true
  }
  // Why: Bitbucket Cloud reports the pull request's source commit as an abbreviated hash.
  return (
    review.provider === 'bitbucket' &&
    BITBUCKET_SHORT_HASH.test(reviewHead) &&
    head.toLowerCase().startsWith(reviewHead.toLowerCase())
  )
}
