import { useMemo } from 'react'

import { canShowWorkspaceDeleteQuickAction } from './workspace-delete-quick-action'
import { useWorktreeCardDetailsHoverControl } from './worktree-card-details-hover-state'
import { getReadOnlyCardProperties, type ResolvedWorktreeCardProps } from './worktree-card-model'
import { useWorktreeCardActivationActions } from './use-worktree-card-activation-actions'
import { useWorktreeCardFoundation } from './use-worktree-card-foundation'
import { useWorktreeCardLifecycleEffects } from './use-worktree-card-lifecycle-effects'
import { useWorktreeCardLinkedDetails } from './use-worktree-card-linked-details'
import { useWorktreeCardReviewDetails } from './use-worktree-card-review-details'
import { useWorktreeCardSecondaryDetails } from './use-worktree-card-secondary-details'
import { useWorktreeCardWorkspaceActions } from './use-worktree-card-workspace-actions'
import { useIsSleepingWorktree } from './use-worktree-sleep-state'
import { hasInlineWorktreeAgentRows } from './worktree-card-spacing'

export function useWorktreeCardController(props: ResolvedWorktreeCardProps) {
  const { worktree, repo, readOnly } = props
  const foundation = useWorktreeCardFoundation({ worktree, repo })
  // Why: resolve read-only policy here so views share one quiet, passive presentation.
  const interactive = !readOnly
  const quietStatusLane = readOnly
  const cardProps = useMemo(
    () => (readOnly ? getReadOnlyCardProperties(foundation.cardProps) : foundation.cardProps),
    [readOnly, foundation.cardProps]
  )
  const isSleeping = useIsSleepingWorktree(worktree.id) && !readOnly
  const deleteState = readOnly ? undefined : foundation.deleteState
  const review = useWorktreeCardReviewDetails({
    worktree,
    repo,
    settings: foundation.settings,
    projectGroups: foundation.projectGroups,
    cardProps,
    newCardStyle: foundation.newCardStyle
  })
  const linked = useWorktreeCardLinkedDetails({
    worktree,
    newCardStyle: foundation.newCardStyle,
    deleteState,
    branch: review.branch,
    issueEntry: review.issueEntry,
    linearIssueEntry: review.linearIssueEntry,
    linearIssueFallbackEntry: review.linearIssueFallbackEntry,
    prDisplay: review.prDisplay
  })

  const showStatus = cardProps.includes('status')
  const showIssue = cardProps.includes('issue')
  const showLinearIssue = cardProps.includes('linear-issue')
  const showJiraIssue = cardProps.includes('jira-issue')
  const showPR = cardProps.includes('pr')
  const showAutomation = cardProps.includes('automation')
  const showCli = cardProps.includes('cli')
  const showComment = cardProps.includes('comment')
  const showPorts = cardProps.includes('ports')
  const shouldRefreshHostedReview = foundation.newCardStyle ? showStatus : showPR
  const detailsHoverControl = useWorktreeCardDetailsHoverControl()
  const hoverDetailsOpen = detailsHoverControl.hoverOpen

  useWorktreeCardLifecycleEffects({
    worktree,
    repo,
    isFolder: review.isFolder,
    hostedReviewCacheKey: review.hostedReviewCacheKey,
    cachedBranchFallbackGitHubPRNumber: review.cachedBranchFallbackGitHubPRNumber,
    linkedGitLabMR: review.linkedGitLabMR,
    linkedBitbucketPR: review.linkedBitbucketPR,
    linkedAzureDevOpsPR: review.linkedAzureDevOpsPR,
    linkedGiteaPR: review.linkedGiteaPR,
    branch: review.branch,
    fetchHostedReviewForBranch: foundation.fetchHostedReviewForBranch,
    shouldRefreshHostedReview,
    newCardStyle: foundation.newCardStyle,
    hoverDetailsOpen,
    showIssue,
    issueCacheKey: review.issueCacheKey,
    fetchIssue: foundation.fetchIssue,
    showLinearIssue,
    fetchLinearIssue: foundation.fetchLinearIssue
  })

  const activation = useWorktreeCardActivationActions({
    worktree,
    repo,
    affiliateListMode: props.affiliateListMode,
    onSelectionGesture: props.onSelectionGesture,
    isActive: props.isActive,
    activationRowKey: props.activationRowKey,
    onActivate: props.onActivate,
    onWorktreeCardClick: props.onWorktreeCardClick,
    onImmediateActivate: props.onImmediateActivate,
    isDeleting: linked.isDeleting,
    isSshDisconnected: foundation.isSshDisconnected,
    updateWorktreeMeta: foundation.updateWorktreeMeta,
    openModal: foundation.openModal
  })

  // Why: delete is destructive, so it only appears while holding Option/Alt, not in the ordinary hover chrome.
  const showDeleteQuickAction =
    !props.affiliateListMode &&
    canShowWorkspaceDeleteQuickAction({
      deleteModifierPressed: linked.deleteModifierPressed,
      isDeleting: linked.isDeleting,
      isMainWorktree: worktree.isMainWorktree
    })
  const workspaceActions = useWorktreeCardWorkspaceActions({
    worktree,
    lineageChildCount: props.lineageChildCount,
    lineageCollapsed: props.lineageCollapsed,
    onLineageToggle: props.onLineageToggle,
    isMultiSelected: props.isMultiSelected,
    selectedWorktrees: props.selectedWorktrees,
    onCardDragStart: props.onCardDragStart,
    onCardDragEnd: props.onCardDragEnd,
    onContextMenuSelect: props.onContextMenuSelect,
    folderWorkspaceId: review.folderWorkspaceId,
    deleteFolderWorkspace: foundation.deleteFolderWorkspace,
    setActiveWorktree: foundation.setActiveWorktree,
    setShowRenameErrorDialog: foundation.setShowRenameErrorDialog,
    isDeleting: linked.isDeleting,
    showDeleteQuickAction
  })

  const secondary = useWorktreeCardSecondaryDetails({
    worktree,
    repo,
    statusPrDisplay: props.statusPrDisplay,
    showLiveState: !readOnly,
    showStatus,
    showIssue,
    showLinearIssue,
    showJiraIssue,
    showPR,
    showAutomation,
    showCli,
    showComment,
    showPorts,
    issueDisplay: linked.issueDisplay,
    linearIssue: linked.linearIssue,
    linearIssueDisplay: linked.linearIssueDisplay,
    jiraIssueDisplay: linked.jiraIssueDisplay,
    prDisplay: review.prDisplay,
    linkedGitLabMR: review.linkedGitLabMR,
    linkedBitbucketPR: review.linkedBitbucketPR,
    linkedAzureDevOpsPR: review.linkedAzureDevOpsPR,
    linkedGiteaPR: review.linkedGiteaPR,
    cardProps,
    newCardStyle: foundation.newCardStyle,
    compactCards: foundation.compactCards,
    agentActivityDisplayMode: foundation.agentActivityDisplayMode,
    workspacePorts: foundation.workspacePorts,
    openTaskPage: foundation.openTaskPage,
    updateWorktreeMeta: foundation.updateWorktreeMeta,
    settings: foundation.settings
  })

  return {
    ...props,
    ...foundation,
    cardProps,
    deleteState,
    interactive,
    quietStatusLane,
    // Caller-owned recovery rows keep the sidebar header's padding even when compact cards hide live agents.
    callerRowsAffectSurfacePadding: !readOnly,
    inlineAgentRowsAffectSurfacePadding: hasInlineWorktreeAgentRows({
      cardProperties: foundation.cardProps,
      newCardStyle: foundation.newCardStyle,
      compactCards: foundation.compactCards
    }),
    isSleeping,
    ...review,
    ...linked,
    detailsHoverControl,
    showStatus,
    showIssue,
    showLinearIssue,
    showJiraIssue,
    showPR,
    showAutomation,
    showCli,
    showComment,
    showPorts,
    shouldRefreshHostedReview,
    ...activation,
    showDeleteQuickAction,
    ...workspaceActions,
    // Why: a read-only card's children are always listed, so its chip names them without a toggle.
    showLineageChildChip: readOnly
      ? props.lineageChildCount > 0
      : workspaceActions.showLineageChildChip,
    ...secondary
  }
}

export type WorktreeCardController = ReturnType<typeof useWorktreeCardController>
