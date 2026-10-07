import { useCallback, useEffect, useRef } from 'react'
import {
  checksPanelReviewStableKey,
  setPendingPRCommentAiAck,
  takePendingPRCommentAiAck
} from '../pr-comments-ai-launch-ack'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelReviewDataState } from './use-checks-panel-review-data'
import type { ChecksPanelPollingState } from './use-checks-panel-polling'
import { acknowledgeCommentResolutionAfterDelivery } from '../pr-comment-resolution-after-delivery'
import { clearPRCommentsListSelection } from '../pr-comments-list-selection'
import { registerOpenChecksPanelView } from './open-checks-panel-views'
import type { ChecksAgentComposerState } from './panel-state-types'
import type { ChecksPanelReview } from '../checks-panel-review'

type ChecksPanelAiAcknowledgementInput = Pick<
  ChecksPanelControllerState,
  | 'addPRConversationComment'
  | 'addPRReviewCommentReply'
  | 'asyncResultKeyRef'
  | 'claimedCommentResolutionRef'
  | 'commentsRef'
  | 'commentsSelectionClearTokenRef'
  | 'pendingCommentResolutionRef'
  | 'resolveReviewThread'
  | 'setCommentResolutionAckBusyNow'
  | 'setComments'
  | 'setCommentsSelectionClearRequest'
  | 'settings'
  | 'commentResolutionLaunchAcceptedRef'
> &
  Pick<ChecksPanelReviewDataState, 'fetchComments'> &
  Pick<ChecksPanelPollingState, 'fetchGitLabDetails'>

export function useChecksPanelAiAcknowledgement(model: ChecksPanelAiAcknowledgementInput) {
  const {
    addPRConversationComment,
    addPRReviewCommentReply,
    asyncResultKeyRef,
    claimedCommentResolutionRef,
    commentsRef,
    commentsSelectionClearTokenRef,
    fetchComments,
    fetchGitLabDetails,
    pendingCommentResolutionRef,
    resolveReviewThread,
    setCommentResolutionAckBusyNow,
    setComments,
    setCommentsSelectionClearRequest,
    settings,
    commentResolutionLaunchAcceptedRef
  } = model
  const clearSentCommentSelection = useCallback(
    (reviewContextKey: string): void => {
      clearPRCommentsListSelection(reviewContextKey)
      commentsSelectionClearTokenRef.current += 1
      setCommentsSelectionClearRequest({
        contextKey: reviewContextKey,
        token: commentsSelectionClearTokenRef.current
      })
    },
    [commentsSelectionClearTokenRef, setCommentsSelectionClearRequest]
  )

  const refreshCommentsAfterBulkResolve = useCallback(
    async (provider: ChecksPanelReview['provider']): Promise<void> => {
      if (provider === 'gitlab') {
        await fetchGitLabDetails({ commitAsCurrent: true })
        return
      }
      await fetchComments({ force: true })
    },
    [fetchComments, fetchGitLabDetails]
  )

  // Lends this panel to a resolution that runs without its click, after a window reload.
  useEffect(
    () =>
      registerOpenChecksPanelView({
        stableKey: () => checksPanelReviewStableKey(asyncResultKeyRef.current),
        existingComments: () => commentsRef.current,
        setComments,
        refresh: refreshCommentsAfterBulkResolve
      }),
    [asyncResultKeyRef, commentsRef, setComments, refreshCommentsAfterBulkResolve]
  )

  const resolveSelectedThreadsAfterLaunch = useCallback(
    async (resolution: NonNullable<ChecksAgentComposerState['commentResolution']>) => {
      clearSentCommentSelection(resolution.reviewContextKey)
      // Why: ignore headSha churn; only abort resolve/UI refresh if the user left this PR/panel.
      const launchStableKey = checksPanelReviewStableKey(resolution.reviewContextKey)
      await acknowledgeCommentResolutionAfterDelivery(resolution, {
        actions: {
          resolveReviewThread,
          addPRReviewCommentReply,
          addPRConversationComment,
          settings
        },
        view: {
          isStillOnLaunchReview: () =>
            checksPanelReviewStableKey(asyncResultKeyRef.current) === launchStableKey,
          existingComments: () => commentsRef.current,
          setComments,
          refresh: () => refreshCommentsAfterBulkResolve(resolution.provider)
        },
        refreshCache: async () => {}
      })
    },
    [
      addPRConversationComment,
      addPRReviewCommentReply,
      clearSentCommentSelection,
      refreshCommentsAfterBulkResolve,
      resolveReviewThread,
      settings,
      commentsRef,
      setComments,
      asyncResultKeyRef
    ]
  )

  /**
   * Tab created: park the payload so panel churn during submit-after-ready cannot drop it.
   * Posts nothing — fixing replies and resolves are irreversible and wait for delivery.
   */
  const claimPendingCommentResolutionForLaunch = useCallback((): void => {
    const pendingResolution = takePendingPRCommentAiAck() ?? pendingCommentResolutionRef.current
    pendingCommentResolutionRef.current = null
    if (!pendingResolution) {
      return
    }
    claimedCommentResolutionRef.current = pendingResolution
    commentResolutionLaunchAcceptedRef.current = true
    setCommentResolutionAckBusyNow(true)
  }, [
    setCommentResolutionAckBusyNow,
    claimedCommentResolutionRef,
    pendingCommentResolutionRef,
    commentResolutionLaunchAcceptedRef
  ])

  /** Launch failed after the tab existed: hand the payload back for a retry, post nothing. */
  const releaseClaimedCommentResolutionAfterFailedLaunch = useCallback((): void => {
    const claimed = claimedCommentResolutionRef.current
    claimedCommentResolutionRef.current = null
    commentResolutionLaunchAcceptedRef.current = false
    if (claimed) {
      pendingCommentResolutionRef.current = claimed
      setPendingPRCommentAiAck(claimed)
    }
    setCommentResolutionAckBusyNow(false)
  }, [
    setCommentResolutionAckBusyNow,
    claimedCommentResolutionRef,
    pendingCommentResolutionRef,
    commentResolutionLaunchAcceptedRef
  ])

  /** Prompt reached the agent: only now may Orca write to the host. */
  const consumeClaimedCommentResolutionAfterDelivery = useCallback(
    (launch?: { followUpDeferred?: boolean }): void => {
      const resolution =
        claimedCommentResolutionRef.current ??
        takePendingPRCommentAiAck() ??
        pendingCommentResolutionRef.current
      claimedCommentResolutionRef.current = null
      pendingCommentResolutionRef.current = null
      commentResolutionLaunchAcceptedRef.current = false
      // Left on the launch's record for the next start to run: posting here would post twice.
      if (!resolution || launch?.followUpDeferred) {
        setCommentResolutionAckBusyNow(false)
        return
      }
      setCommentResolutionAckBusyNow(true)
      void resolveSelectedThreadsAfterLaunch(resolution).finally(() =>
        setCommentResolutionAckBusyNow(false)
      )
    },
    [
      resolveSelectedThreadsAfterLaunch,
      setCommentResolutionAckBusyNow,
      claimedCommentResolutionRef,
      pendingCommentResolutionRef,
      commentResolutionLaunchAcceptedRef
    ]
  )
  // Why: auto-start can capture a stale callback; always call the latest consumer.
  const consumeClaimedCommentResolutionAfterDeliveryRef = useRef(
    consumeClaimedCommentResolutionAfterDelivery
  )
  const claimPendingCommentResolutionForLaunchRef = useRef(claimPendingCommentResolutionForLaunch)
  const releaseClaimedCommentResolutionAfterFailedLaunchRef = useRef(
    releaseClaimedCommentResolutionAfterFailedLaunch
  )
  useEffect(() => {
    consumeClaimedCommentResolutionAfterDeliveryRef.current =
      consumeClaimedCommentResolutionAfterDelivery
    claimPendingCommentResolutionForLaunchRef.current = claimPendingCommentResolutionForLaunch
    releaseClaimedCommentResolutionAfterFailedLaunchRef.current =
      releaseClaimedCommentResolutionAfterFailedLaunch
  }, [
    consumeClaimedCommentResolutionAfterDelivery,
    claimPendingCommentResolutionForLaunch,
    releaseClaimedCommentResolutionAfterFailedLaunch
  ])
  const handleLaunchAccepted = useCallback((): void => {
    claimPendingCommentResolutionForLaunchRef.current()
  }, [])
  const handleLaunchAborted = useCallback((): void => {
    releaseClaimedCommentResolutionAfterFailedLaunchRef.current()
  }, [])
  return {
    clearSentCommentSelection,
    refreshCommentsAfterBulkResolve,
    resolveSelectedThreadsAfterLaunch,
    handleLaunchAccepted,
    handleLaunchAborted,
    consumeClaimedCommentResolutionAfterDeliveryRef
  }
}

export type ChecksPanelAiAcknowledgementState = ReturnType<typeof useChecksPanelAiAcknowledgement>
