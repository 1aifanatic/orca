import type { PRComment } from '../../../../../shared/github/comment-types'
import {
  checksPanelReviewStableKey,
  type PendingPRCommentAiAck
} from '../pr-comments-ai-launch-ack'
import type { CommentResolutionAfterDeliveryDeps } from '../pr-comment-resolution-after-delivery'

/** What a mounted Checks panel lends a resolution that runs without its click (after a reload). */
export type OpenChecksPanelView = {
  /** The review it shows now, as `checksPanelReviewStableKey` keys it. */
  stableKey: () => string
  existingComments: () => readonly PRComment[]
  setComments: (update: (previous: PRComment[]) => PRComment[]) => void
  /** Re-reads the review's comments from its provider, as the panel's own click does. */
  refresh: (provider: PendingPRCommentAiAck['provider']) => Promise<void>
}

const views = new Set<OpenChecksPanelView>()

export function registerOpenChecksPanelView(view: OpenChecksPanelView): () => void {
  views.add(view)
  return () => {
    views.delete(view)
  }
}

/** The open panel showing this resolution's review, as its `view`; none when no panel shows it. */
export function openChecksPanelViewFor(
  resolution: PendingPRCommentAiAck
): CommentResolutionAfterDeliveryDeps['view'] {
  const launchKey = checksPanelReviewStableKey(resolution.reviewContextKey)
  for (const view of views) {
    if (view.stableKey() === launchKey) {
      return {
        isStillOnLaunchReview: () => view.stableKey() === launchKey,
        existingComments: view.existingComments,
        setComments: view.setComments,
        refresh: () => view.refresh(resolution.provider)
      }
    }
  }
  return undefined
}
