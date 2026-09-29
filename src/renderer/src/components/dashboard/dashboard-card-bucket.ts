import {
  dashboardCardDisplayState,
  type DashboardBucket,
  type DashboardCard,
  type DashboardCardDisplayState
} from '../../../../shared/dashboard-snapshot'

export function dashboardBucketForDotState(state: DashboardCardDisplayState): DashboardBucket {
  switch (state) {
    case 'working':
    case 'monitoring':
      return 'working'
    // Why: a failure ranks like a completion (see agentTurnStoppedByUser), so it is not a question.
    case 'done':
    case 'failed':
    case 'interrupted':
      return 'done'
    case 'idle':
      return 'idle'
    case 'blocked':
    case 'waiting':
      return 'attention'
  }
}

/** The card's column. A seen verdict on a finished row settles into Idle like a seen completion,
 *  while its dot keeps the mark. */
export function dashboardCardBucket(
  card: Pick<DashboardCard, 'dotState' | 'workingMode' | 'unseen' | 'verdictMark'>
): DashboardBucket {
  if (card.verdictMark && card.dotState === 'done' && !card.unseen) {
    return 'idle'
  }
  return dashboardBucketForDotState(dashboardCardDisplayState(card))
}
