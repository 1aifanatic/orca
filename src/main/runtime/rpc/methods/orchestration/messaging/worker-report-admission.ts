import { OrchestrationError } from '../../../../orchestration/orchestration-error'

// Why: one rule for local and remote workers. Only a stop in flight mutes a worker; an unknown
// start or stop is unverifiable, not exited (docs/reference/ssh-execution-boundary.md).
export function workerStopInFlightReason(
  dispatchId: string,
  workerState: string | undefined
): string | undefined {
  return workerState === 'stopping'
    ? `Dispatch ${dispatchId} is stopping; its worker cannot report until worker-stop settles.`
    : undefined
}

export function assertWorkerCanReport(args: {
  dispatchId: string
  from: string
  workerState: string | undefined
  processCurrent: boolean
}): void {
  const stopping = workerStopInFlightReason(args.dispatchId, args.workerState)
  if (stopping) {
    throw new OrchestrationError('dispatch_inactive', stopping)
  }
  if (!args.processCurrent) {
    throw new OrchestrationError(
      'worker_identity_changed',
      `${args.from} is not the exact process that owns Dispatch ${args.dispatchId}.`
    )
  }
}
