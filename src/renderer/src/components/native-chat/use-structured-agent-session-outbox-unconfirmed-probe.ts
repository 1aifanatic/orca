import { useEffect, useLayoutEffect, useRef } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { admitStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox-admission'
import { structuredAgentSessionEntryResendsUnconfirmed } from '../../../../shared/structured-agent-session-outbox-unconfirmed-resend'
import {
  STRUCTURED_AGENT_SESSION_SEND_UNCONFIRMED_WORDS,
  structuredAgentSessionEntryOutlivedHostWindow
} from '../../../../shared/structured-agent-session-send-settlement'
import {
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'
import { settleStructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox-dispatch'

const UNCONFIRMED_PROBE_BASE_DELAY_MS = 1_000
/** No attempt ceiling: a transport outage outlives any fixed budget, and the host's answer is what
 *  ends it. Growth caps the rate at one resend per 16s. */
const UNCONFIRMED_PROBE_MAX_DELAY_MS = 16_000

/** Re-queues the entry holding the outbox in `unconfirmed`, with backoff, until the host answers. */
export function useStructuredAgentSessionOutboxUnconfirmedProbe(args: {
  sessionId: string
  outbox: readonly StructuredAgentSessionOutboxEntry[]
  submissions: readonly AgentJournalSubmission[]
  owner: { attached: boolean; ownerChange: number | null; targetKey: string }
}): void {
  const { outbox, owner, sessionId, submissions } = args
  const probeAttemptsRef = useRef({ id: null as string | null, attempts: 0 })
  useLayoutEffect(() => {
    probeAttemptsRef.current = { id: null, attempts: 0 }
  }, [owner.ownerChange, owner.targetKey, sessionId])

  // A send with no answer may never have reached the host, and nothing else moves it out of
  // `unconfirmed`, so one would wedge the whole FIFO queue. The same id again is idempotent: the
  // host replays a recorded answer or performs a genuine first delivery. The entry the queue's
  // admission is blocked on is the one resent, never one a Stop outran or an older build left.
  const admission = admitStructuredAgentSessionOutboxEntry(outbox)
  const blocker = admission.state === 'blocked' ? admission.entry : undefined
  // The delivery notices read the same rule: while it is resent here, its row says it is sending.
  // Primitives only: `submissions` is rebuilt on every streaming batch, and an array-identity dep
  // would reset the backoff forever while the agent is working.
  const probeId =
    blocker &&
    blocker.sessionId === sessionId &&
    structuredAgentSessionEntryResendsUnconfirmed(blocker, submissions)
      ? blocker.clientMessageId
      : null
  useEffect(() => {
    if (probeId === null || !owner.attached) {
      return
    }
    const attempts = probeAttemptsRef.current.id === probeId ? probeAttemptsRef.current.attempts : 0
    const timer = setTimeout(
      () => {
        probeAttemptsRef.current = { id: probeId, attempts: attempts + 1 }
        const current = getStructuredAgentSessionOutbox(sessionId)
        const entry = current.find((candidate) => candidate.clientMessageId === probeId)
        if (!entry) {
          return
        }
        // Past the host's window no answer can settle it, and the person checks the chat instead.
        if (structuredAgentSessionEntryOutlivedHostWindow(entry, Date.now())) {
          settleStructuredAgentSessionOutboxEntry(sessionId, probeId, {
            kind: 'returned',
            words: [...STRUCTURED_AGENT_SESSION_SEND_UNCONFIRMED_WORDS]
          })
          return
        }
        commitStructuredAgentSessionOutbox(
          sessionId,
          current.map((candidate) =>
            candidate === entry ? { ...candidate, state: 'queued' as const } : candidate
          )
        )
      },
      Math.min(UNCONFIRMED_PROBE_BASE_DELAY_MS * 2 ** attempts, UNCONFIRMED_PROBE_MAX_DELAY_MS)
    )
    return () => clearTimeout(timer)
  }, [owner.attached, owner.ownerChange, owner.targetKey, probeId, sessionId])
}
