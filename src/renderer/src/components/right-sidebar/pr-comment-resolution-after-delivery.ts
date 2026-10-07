import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { mergePRCommentIntoList } from '@/store/github/pr-comment-cache'
import type { AppState } from '@/store/types'
import type { PRComment } from '../../../../shared/github/comment-types'
import {
  acknowledgePRCommentsAfterAiLaunch,
  attachPRReviewReplyParent,
  canPostPRReviewThreadReply,
  hasPRCommentGroupNeedingReply,
  resolvePRReviewReplyThreadId,
  type PendingPRCommentAiAck
} from './pr-comments-ai-launch-ack'
import { buildSnapshottedThreadResolver } from './pr-comment-snapshotted-thread-resolver'
import { markPRCommentThreadResolved } from './pr-comment-thread-resolution'
import { resolveGitLabMRDiscussionForChecks } from './checks-panel/gitlab-review-client'

export type CommentResolutionAfterDeliveryDeps = {
  actions: Pick<
    AppState,
    'resolveReviewThread' | 'addPRReviewCommentReply' | 'addPRConversationComment' | 'settings'
  >
  /** The Checks panel showing this review now; absent when none is (a window that reloaded). */
  view?: {
    isStillOnLaunchReview: () => boolean
    existingComments: () => readonly PRComment[]
    setComments: (update: (previous: PRComment[]) => PRComment[]) => void
    refresh: () => Promise<void>
  }
  /** With no panel on that review: refresh the cached comments, so one opened later shows them. */
  refreshCache: () => Promise<void>
}

/**
 * Resolves the threads a Checks "Resolve comments" launch sent and posts its "fixing" replies,
 * once its prompt reached the agent. The one implementation, for the panel's own click and for a
 * window that reloaded mid-launch and runs the click's recorded follow-up.
 */
export async function acknowledgeCommentResolutionAfterDelivery(
  resolution: PendingPRCommentAiAck,
  deps: CommentResolutionAfterDeliveryDeps
): Promise<void> {
  try {
    await acknowledge(resolution, deps)
  } catch (error) {
    console.warn('Failed to resolve/reply on selected review comments after AI launch:', error)
    toast.error(
      translate(
        'auto.components.right.sidebar.ChecksPanel.495b2f8c4b',
        'Started the agent, but could not resolve or reply on the selected comments.'
      )
    )
  }
}

async function acknowledge(
  resolution: PendingPRCommentAiAck,
  { actions, view, refreshCache }: CommentResolutionAfterDeliveryDeps
): Promise<void> {
  // Why: the host calls keep the snapshotted target, but every UI mutation must belong to the
  // review the panel is showing now — otherwise replies land in another PR's list.
  const isPanelStillOnLaunchReview = (): boolean => view?.isStillOnLaunchReview() ?? false
  const githubTarget = resolution.githubTarget
  const canReplyOnHost = resolution.provider === 'github' && githubTarget != null
  // Why: only GitHub posts fixing replies today; a GitLab MR reaching replied=0 is expected,
  // and a missing reply target only matters when something in the selection needs a reply.
  let lastHostError =
    resolution.provider === 'github' &&
    githubTarget == null &&
    hasPRCommentGroupNeedingReply(resolution.selectedGroups)
      ? translate(
          'auto.components.right.sidebar.ChecksPanel.7e4b2a19c0',
          'Could not resolve the GitHub PR to reply on.'
        )
      : undefined
  const resolveSnapshottedThread = buildSnapshottedThreadResolver({
    provider: resolution.provider,
    githubResolveTarget: resolution.githubResolveTarget,
    gitlabTarget: resolution.gitlabTarget,
    resolveReviewThread: actions.resolveReviewThread,
    resolveGitLabDiscussion: (args) =>
      resolveGitLabMRDiscussionForChecks({ ...args, settings: actions.settings }),
    isPanelStillOnLaunchReview,
    onResolvedOptimistically: (threadId) => {
      view?.setComments((prev) => markPRCommentThreadResolved(prev, threadId, true))
    },
    onResolveFailed: ({ threadId, error }) => {
      lastHostError =
        error ||
        translate(
          'auto.components.right.sidebar.ChecksPanel.430f1a62d4',
          'Could not resolve the selected thread on the host.'
        )
      console.warn('Post-launch thread resolve failed:', threadId, error)
    }
  })
  const counts = await acknowledgePRCommentsAfterAiLaunch({
    groups: resolution.selectedGroups,
    deps: {
      resolveThread: resolveSnapshottedThread,
      canReply: canReplyOnHost,
      replyInThread: async (comment, body) => {
        if (!githubTarget || !canPostPRReviewThreadReply(comment)) {
          return false
        }
        try {
          const parentThreadId =
            resolvePRReviewReplyThreadId({
              parent: comment,
              existingComments: view?.existingComments() ?? []
            }) ?? comment.threadId
          const result = await actions.addPRReviewCommentReply(
            githubTarget.repoPath,
            githubTarget.prNumber,
            comment.id,
            body,
            {
              repoId: githubTarget.repoId,
              prRepo: githubTarget.prRepo,
              threadId: parentThreadId,
              path: comment.path,
              line: comment.line
            }
          )
          if (result.ok) {
            // Why: force threadId/path onto the optimistic row so the sidebar groups it
            // under the parent immediately (API payload may omit them).
            if (isPanelStillOnLaunchReview()) {
              view?.setComments((prev) =>
                mergePRCommentIntoList(
                  prev,
                  attachPRReviewReplyParent(result.comment, {
                    ...comment,
                    threadId: parentThreadId
                  })
                )
              )
            }
            return true
          }
          lastHostError = result.error
          console.warn('In-thread fixing reply failed:', result.error)
          return false
        } catch (err) {
          lastHostError = err instanceof Error ? err.message : String(err)
          console.warn('Failed to post in-thread fixing reply for review comment:', err)
          return false
        }
      },
      // Why: CodeRabbit / review-summary / conversation comments have no nested-reply
      // API, so the ack sends one combined body for all of them.
      replyAsConversation: async (body) => {
        if (!githubTarget) {
          return false
        }
        try {
          const result = await actions.addPRConversationComment(
            githubTarget.repoPath,
            githubTarget.prNumber,
            body,
            { repoId: githubTarget.repoId, prRepo: githubTarget.prRepo }
          )
          if (result.ok) {
            if (isPanelStillOnLaunchReview()) {
              view?.setComments((prev) => mergePRCommentIntoList(prev, result.comment))
            }
            return true
          }
          lastHostError = result.error
          console.warn('Conversation fixing reply failed:', result.error)
          return false
        } catch (err) {
          lastHostError = err instanceof Error ? err.message : String(err)
          console.warn('Failed to post conversation fixing reply for review comment:', err)
          return false
        }
      }
    }
  })

  await (view && isPanelStillOnLaunchReview() ? view.refresh() : refreshCache())

  // Why: surface the underlying API error when replies were possible but none landed.
  // Resolvable threads are acked by resolving, so replied=0 is correct when nothing needed one.
  const repliedNoneDespiteHostSupport =
    canReplyOnHost &&
    counts.replied === 0 &&
    hasPRCommentGroupNeedingReply(resolution.selectedGroups)
  if (counts.failed > 0 || repliedNoneDespiteHostSupport || lastHostError) {
    toast.error(
      translate(
        'auto.components.right.sidebar.ChecksPanel.f273f2271c',
        'Started the agent. Marked {{value0}} resolved, replied to {{value1}}, skipped {{value2}}, failed {{value3}}.{{value4}}',
        {
          value0: counts.resolved,
          value1: counts.replied,
          value2: counts.skipped,
          value3: counts.failed,
          value4: lastHostError ? ` ${lastHostError}` : ''
        }
      )
    )
    return
  }
  toast.success(
    translate(
      'auto.components.right.sidebar.ChecksPanel.aa95b81a3a',
      'Started the agent. Marked {{value0}} resolved, replied to {{value1}}, skipped {{value2}}, failed {{value3}}.',
      {
        value0: counts.resolved,
        value1: counts.replied,
        value2: counts.skipped,
        value3: counts.failed
      }
    )
  )
}
