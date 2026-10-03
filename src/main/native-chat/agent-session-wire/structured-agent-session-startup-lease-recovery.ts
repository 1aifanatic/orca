// Startup's recovery of the leases a crash left `recovering`: a provider process that outlived the
// crash is stopped and its death recorded, so each settle verdict reads that evidence. Each lease is
// recovered once per host, within a budget, by whichever startup phase asks first, so one phase
// waits only on the leases of the chats it opens.

import { forEachWithConcurrency } from '../../../shared/map-with-concurrency'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import type { StructuredAgentSessionStartupStateDeps } from './structured-agent-session-startup-state'

// Record-only (a probe and at most a process stop each), so a few at once.
const RECOVERY_CONCURRENCY = 4
// A recovery is process probes around at most one stop (its SIGTERM grace is 5.5 s). Past this a
// probe has stopped answering: the lease stays `recovering`, unverified and never called dead, for
// the next attach or send to resolve, and startup goes on.
const RECOVERY_BUDGET_MS = 15_000

export type StructuredAgentSessionStartupLeaseRecovery = {
  /** Starts the recovery of every lease `recovering` at this call, listed or not, and ends once
   *  each has ended or outlasted its budget; a lease a later reconcile moved there is included the
   *  next call. Never rejects. */
  recoverAll: () => Promise<void>
  /** A restore's resolver. A `recovering` lease answers its one recovery, or true once that
   *  outlasts its budget: a second beside it could hang the same way, so its chat opens unverified.
   *  Any other lease is resolved as `resolveRecovery` resolves it. */
  resolve: (sessionId: string) => Promise<boolean>
}

export function createStructuredAgentSessionStartupLeaseRecovery(
  deps: Pick<StructuredAgentSessionStartupStateDeps, 'openDeps' | 'resolveRecovery'> & {
    budgetMs?: number
  }
): StructuredAgentSessionStartupLeaseRecovery {
  const budgetMs = deps.budgetMs ?? RECOVERY_BUDGET_MS
  const recoveries = new Map<string, Promise<boolean>>()
  const recovering = (sessionId: string) =>
    deps.openDeps.store.getRecord(sessionId)?.lease.handoffStage === 'recovering'
  const recoverOnce = (sessionId: string): Promise<boolean> => {
    let recovery = recoveries.get(sessionId)
    if (!recovery) {
      recovery = withTimeout<boolean | null>(deps.resolveRecovery(sessionId), budgetMs, null).then(
        (resolved) => {
          if (resolved !== null) {
            return resolved
          }
          deps.openDeps.logger.warn('a chat recovery outlasted startup; left unverified', {
            scope: 'startup-recovery-timeout',
            sessionId
          })
          return true
        }
      )
      recoveries.set(sessionId, recovery)
    }
    return recovery
  }
  return {
    recoverAll: () =>
      forEachWithConcurrency(
        deps.openDeps.store
          .listRecords()
          .filter((record) => record.lease.handoffStage === 'recovering'),
        RECOVERY_CONCURRENCY,
        async ({ sessionId }) => {
          await recoverOnce(sessionId)
        }
      ),
    resolve: (sessionId) =>
      recoveries.has(sessionId) || recovering(sessionId)
        ? recoverOnce(sessionId)
        : deps.resolveRecovery(sessionId)
  }
}
