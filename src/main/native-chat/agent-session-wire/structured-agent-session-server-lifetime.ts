import {
  stopStructuredAgentSessionAgentUnderSerialize,
  type StructuredAgentSessionLifetimeContext
} from './structured-agent-session-host-lifetime'
import { replayJournal } from '../agent-session-journal/journal-open'
import { renderJournalState } from '../agent-session-journal/journal-reducer'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { structuredAgentSessionOwesWork } from './structured-agent-session-owed-work'
import { isProvenDeadProbe } from '../../../shared/agent-session-lease-adjudication'
import {
  abandonAgentSessionOwnerlessReservation,
  isOwnerlessAgentSessionReservation
} from '../../runtime/agent-session-lease-transitions'
import { ownerlessReservationPastRetirementDeadline } from './structured-agent-session-reservation-retirement'
import { restoreRetiredStructuredAgentSessionConversation } from './structured-agent-session-retired-conversation'
import type { StructuredAgentSessionConversationOpenContext } from './structured-agent-session-conversation-open'

export const STRUCTURED_AGENT_SESSION_UNANSWERED_PROMPT_MAX_AGE_MS = 24 * 60 * 60_000

export function createStructuredAgentSessionServerLifetime(input: {
  context: () => StructuredAgentSessionLifetimeContext
  tasks: StructuredAgentSessionTaskQueue
  deliveryActive: (id: string) => boolean
  childWork: (id: string) => readonly AgentChildWorkView[] | undefined
  stopDelivery: () => void
  adoptOpened: StructuredAgentSessionConversationOpenContext['adoptOpened']
}) {
  const read = (): number | null => {
    const deps = input.context().deps
    try {
      if (
        deps.store.readOnly ||
        deps.journalDatabase.readOnly ||
        deps.store.listHeldSessionIds().some((id) => deps.store.isSessionUnreadable(id))
      ) {
        return null
      }
      let count = 0
      for (const record of deps.store.listRecords()) {
        const session = input.context().sessions.get(record.sessionId)
        // A lease without its transport must be reconciled by its execution host.
        if (
          !session?.child &&
          record.lease.claimStatus !== 'released' &&
          !ownerlessReservationPastRetirementDeadline(
            record,
            deps.platform ?? process.platform,
            deps.now?.() ?? Date.now()
          )
        ) {
          return null
        }
        const loaded = session ? null : replayJournal(deps.journalDatabase.db, record.sessionId)
        if (loaded?.damage || loaded?.newer) {
          return null
        }
        const snapshot =
          session?.journal.snapshot() ?? (loaded ? renderJournalState(loaded.state) : null)
        if (
          snapshot &&
          structuredAgentSessionOwesWork({
            snapshot,
            hasChild: session?.child != null,
            stopping: session?.child?.close !== undefined,
            deliveryActive: input.deliveryActive(record.sessionId),
            childWork: input.childWork(record.sessionId),
            openDispatch: deps.hasOpenDispatch?.(record) === true,
            providerHoldsDispatch: deps.adapter.holdsDispatch?.(record.sessionId) === true
          })
        ) {
          count++
        }
      }
      return count || (input.tasks.hasPending() ? 1 : 0)
    } catch (error) {
      deps.logger.warn('reading structured work before server retirement failed', {
        scope: 'server-retirement',
        error
      })
      return null
    }
  }
  return {
    read,
    abandonOwnerlessReservations: async (): Promise<void> => {
      input.tasks.closeAdmission()
      input.stopDelivery()
      const { deps, runtimeState } = input.context()
      runtimeState.acquireAborts.abortAll('abandoned by user server stop')
      await Promise.allSettled(
        deps.store
          .listRecords()
          .filter(isOwnerlessAgentSessionReservation)
          .map((record) =>
            deps.store
              .transitionHandoff(record.sessionId, (latest) =>
                abandonAgentSessionOwnerlessReservation({
                  record: latest,
                  expectedFence: record.lease.runtimeFence,
                  now: deps.now?.() ?? Date.now()
                })
              )
              .catch((error: unknown) =>
                deps.logger.warn('recording user abandonment of a reservation failed', {
                  scope: 'server-reservation-abandon',
                  sessionId: record.sessionId,
                  error
                })
              )
          )
      )
    },
    observe: async (): Promise<number | null> => {
      try {
        const context = input.context()
        for (const { sessionId } of context.deps.store.listRecords()) {
          if (!context.sessions.get(sessionId)?.child) {
            await input.tasks.serialize(sessionId, async () => {
              const current = input.context()
              const record = current.deps.store.getRecord(sessionId)
              if (!record || current.sessions.get(sessionId)?.child) {
                return
              }
              if (record.lease.claimStatus !== 'released') {
                const probe = await current.runtimeState.probeRecord(record)
                if (
                  isProvenDeadProbe(probe) ||
                  (record.lease.ownerProcess === null && probe.outcome === 'reservation-unused')
                ) {
                  await current.deps.store.evictProvenDeadOwner({
                    sessionId,
                    expectedFence: record.lease.runtimeFence,
                    probe,
                    now: current.now()
                  })
                }
              }
              await restoreRetiredStructuredAgentSessionConversation(
                { deps: current.deps, sessions: current.sessions, adoptOpened: input.adoptOpened },
                sessionId
              )
            })
          }
        }
        return read()
      } catch (error) {
        input.context().deps.logger.warn('rechecking structured work recovery failed', {
          scope: 'server-retirement',
          error
        })
        return null
      }
    },
    expireUnansweredPrompts: async (): Promise<void> => {
      const expired = (id: string): boolean => {
        const session = input.context().sessions.get(id)
        const now = input.context().deps.now?.() ?? Date.now()
        return (
          session?.child != null &&
          session.journal
            .snapshot()
            .items.some(
              ({ body, observedAt }) =>
                (body.kind === 'approval' || body.kind === 'question') &&
                body.resolution.state === 'pending' &&
                now - observedAt >= STRUCTURED_AGENT_SESSION_UNANSWERED_PROMPT_MAX_AGE_MS
            )
        )
      }
      await Promise.allSettled(
        [...input.context().sessions.keys()].filter(expired).map((id) =>
          input.tasks
            .serialize(id, async () => {
              if (expired(id)) {
                await stopStructuredAgentSessionAgentUnderSerialize(input.context(), id, {
                  cause: 'evict'
                })
              }
            })
            .catch((error: unknown) =>
              input.context().deps.logger.warn('expiring an unanswered prompt failed', {
                scope: 'prompt-expiry',
                sessionId: id,
                error
              })
            )
        )
      )
    },
    /** No await between evidence, the request's commit, and closing admission. */
    admitStop: (commit: () => boolean): boolean => {
      if (read() !== 0 || !commit()) {
        return false
      }
      input.tasks.closeAdmission()
      input.stopDelivery()
      return true
    }
  }
}
