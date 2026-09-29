import type {
  DashboardBucket,
  DashboardCardDisplayState
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
