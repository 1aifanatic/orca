import { useAppStore } from '@/store'
import type { PendingPRCommentAiAck } from './pr-comments-ai-launch-ack'
import { acknowledgeCommentResolutionAfterDelivery } from './pr-comment-resolution-after-delivery'

/**
 * The Checks panel's "resolve the selected comments" follow-up, for a window that reloaded while
 * its launch ran (`agent-launch-follow-ups`): the panel's own implementation, with no panel on
 * screen, then a fresh fetch of the PR's comments so a panel opened later shows them resolved.
 */
export function runReviewCommentsResolutionFollowUp(
  resolution: PendingPRCommentAiAck
): Promise<void> {
  const store = useAppStore.getState()
  const target = resolution.githubResolveTarget
  return acknowledgeCommentResolutionAfterDelivery(resolution, {
    actions: store,
    refreshCache: async () => {
      // GitHub's cached comments; GitLab's are not refreshed here.
      if (resolution.provider === 'github' && target) {
        await useAppStore.getState().fetchPRComments(target.repoPath, target.prNumber, {
          force: true,
          repoId: target.repoId,
          ...(target.prRepo ? { prRepo: target.prRepo } : {})
        })
      }
    }
  })
}
