// Who owns an outbox entry's text when it leaves this client's queue without a
// send answer. A Stop hands unsent text back to the composer; a host that
// visibly holds the entry as a queued draft (same id), or that returned its
// text through `withdrawnQueued`, owns it — those entries retire with no local
// restore, so the same words can never come back twice.

import { useCallback, useEffect } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import {
  withdrawUnsentStructuredAgentSessionOutboxEntries,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { writeOutbox } from './structured-agent-session-outbox-storage'
import type { useStructuredAgentSessionWithdrawnRestore } from './structured-agent-session-withdrawn-message-restore'

export function useStructuredAgentSessionOutboxOwnership(args: {
  sessionId: string
  submissions: readonly AgentJournalSubmission[]
  /** Ids of the host's published drafts; an entry with one of these ids is host-owned. */
  queuedMessageIds: readonly string[] | undefined
  outboxRef: { current: StructuredAgentSessionOutboxEntry[] }
  blockedIdRef: { current: string | null }
  /** The send in flight and its generation: a host that holds that send answered it. */
  inFlightIdRef: { current: string | null }
  dispatchGenerationRef: { current: number }
  setOutbox: (entries: StructuredAgentSessionOutboxEntry[]) => void
  restoreWithdrawn: ReturnType<typeof useStructuredAgentSessionWithdrawnRestore>
}): {
  /** Stop's local step, before its RPC, so the drain has nothing left to send after it.
   *  Returns the withdrawn ids: a capable Stop's `withdrawnQueued` restore must skip
   *  text this client already put back in the composer. */
  withdrawUnsent: () => string[]
  /** Drop host-owned entries without a restore. */
  retire: (ids: readonly string[]) => void
} {
  const { blockedIdRef, outboxRef, queuedMessageIds, restoreWithdrawn, sessionId, setOutbox } = args
  const { dispatchGenerationRef, inFlightIdRef, submissions } = args

  const withdrawUnsent = useCallback((): string[] => {
    const next = withdrawUnsentStructuredAgentSessionOutboxEntries(
      outboxRef.current,
      submissions,
      blockedIdRef.current
    )
    if (next.length === outboxRef.current.length) {
      return []
    }
    const withdrawn = outboxRef.current.filter((entry) => !next.includes(entry))
    restoreWithdrawn.byStop(withdrawn)
    outboxRef.current = next
    setOutbox(next)
    writeOutbox(sessionId, next)
    return withdrawn.map((entry) => entry.clientMessageId)
  }, [blockedIdRef, outboxRef, restoreWithdrawn, sessionId, setOutbox, submissions])

  const retire = useCallback(
    (ids: readonly string[]): void => {
      const owned = new Set(ids)
      // Like a journal row answering it: free single-flight and void the unsettled send's reply.
      if (inFlightIdRef.current !== null && owned.has(inFlightIdRef.current)) {
        dispatchGenerationRef.current += 1
        inFlightIdRef.current = null
      }
      const next = outboxRef.current.filter((entry) => !owned.has(entry.clientMessageId))
      if (next.length !== outboxRef.current.length) {
        outboxRef.current = next
        setOutbox(next)
        writeOutbox(sessionId, next)
      }
    },
    [dispatchGenerationRef, inFlightIdRef, outboxRef, sessionId, setOutbox]
  )

  useEffect(() => {
    if (queuedMessageIds && queuedMessageIds.length > 0) {
      retire(queuedMessageIds)
    }
  }, [queuedMessageIds, retire])

  return { withdrawUnsent, retire }
}
