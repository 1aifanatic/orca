import {
  stopStructuredAgentSessionAgentUnderSerialize,
  type StructuredAgentSessionLifetimeContext
} from './structured-agent-session-host-lifetime'
import { replayJournal } from '../agent-session-journal/journal-open'
import { renderJournalState } from '../agent-session-journal/journal-reducer'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { structuredAgentSessionOwesWork } from './structured-agent-session-owed-work'

export const STRUCTURED_AGENT_SESSION_UNANSWERED_PROMPT_MAX_AGE_MS = 24 * 60 * 60_000

export function createStructuredAgentSessionServerLifetime(input: {
  context: () => StructuredAgentSessionLifetimeContext
  tasks: StructuredAgentSessionTaskQueue
  deliveryActive: (id: string) => boolean
  childWork: (id: string) => readonly AgentChildWorkView[] | undefined
  stopDelivery: () => void
}) {
  const read = (): number | null => {
    const deps = input.context().deps
    try {
      if (deps.store.readOnly || deps.journalDatabase.readOnly) {
        return null
      }
      let count = 0
      for (const record of deps.store.listRecords()) {
        const session = input.context().sessions.get(record.sessionId)
        // A lease without its transport must be reconciled by its execution host.
        if (!session?.child && record.lease.claimStatus !== 'released') {
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
    observe: async (): Promise<number | null> => {
      try {
        const context = input.context()
        for (const { sessionId, lease } of context.deps.store.listRecords()) {
          if (!context.sessions.get(sessionId)?.child && lease.handoffStage === 'recovering') {
            await input.tasks.serialize(sessionId, async () => {
              if (!input.context().sessions.get(sessionId)?.child) {
                await input.context().runtimeState.resolveRecovery(sessionId)
              }
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
          session.child.close === undefined &&
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
