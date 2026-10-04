// A Stop naming no turn, and what it means for the sends it outran. Each press has its own
// operation id, stamped on those sends before the request goes. The Stop's answer, or its refusal,
// is recorded on them; a Stop whose answer was lost goes again under the same id (the host records
// an id once), so every stamp meets an answer. It is not sent again once a newer message exists,
// since then it could stop that message's turn instead.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { parseAgentSessionOperationTimestamp } from '../../../../shared/agent-session-host-authority'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import type { StructuredAgentSessionWriteAs } from './use-structured-agent-session-mutate'
import {
  structuredSessionOperationId,
  type StructuredAgentSessionStopAnswer
} from './use-structured-agent-session-outbox'

const STOP_RESEND_BASE_DELAY_MS = 1_000
const STOP_RESEND_MAX_DELAY_MS = 16_000

/** The oldest Stop still owed an answer by the sends it stamped. */
function unansweredStop(outbox: readonly StructuredAgentSessionOutboxEntry[]): string | null {
  for (const entry of outbox) {
    const stop = entry.stoppedBy
    if (stop && !stop.cursor && stop.unanswerable !== true) {
      return stop.operationId
    }
  }
  return null
}

/** Whether a message was sent after this Stop was pressed, from here or another client: by the
 *  time its id was made, so no host clock is compared. */
function newerSendExists(
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  stopOperationId: string
): boolean {
  const pressedAt = parseAgentSessionOperationTimestamp(stopOperationId)
  const madeAfter = (id: string): boolean =>
    (parseAgentSessionOperationTimestamp(id) ?? -Infinity) > (pressedAt ?? Infinity)
  return (
    outbox.some((entry) => madeAfter(entry.clientMessageId)) ||
    submissions.some((submission) => madeAfter(submission.clientMessageId))
  )
}

export function useStructuredAgentSessionConversationStop(args: {
  outbox: readonly StructuredAgentSessionOutboxEntry[]
  submissions: readonly AgentJournalSubmission[]
  attached: boolean
  writeAs: StructuredAgentSessionWriteAs
  stopOutbox: (stopOperationId: string) => void
  recordStopAnswer: (stopOperationId: string, answer: StructuredAgentSessionStopAnswer) => void
}): () => Promise<void> {
  const { attached, outbox, recordStopAnswer, stopOutbox, submissions, writeAs } = args
  const inFlight = useRef(new Set<string>())
  const [resends, setResends] = useState<{ id: string | null; attempts: number }>({
    id: null,
    attempts: 0
  })

  const sendStop = useCallback(
    async (stopOperationId: string, firstPress: boolean): Promise<void> => {
      if (inFlight.current.has(stopOperationId)) {
        return
      }
      inFlight.current.add(stopOperationId)
      try {
        const outcome = await writeAs(
          stopOperationId,
          'agentSession.cancel',
          'agentSession.cancel',
          {}
        )
        if (outcome.kind === 'done') {
          recordStopAnswer(stopOperationId, { kind: 'answered', cursor: outcome.cursor })
          return
        }
        if (outcome.kind === 'not-done' && firstPress) {
          toast.error(outcome.notice)
        }
        // A refusal is the host's answer; a lost answer goes again from the effect below.
        if (outcome.kind === 'dropped' || outcome.answered) {
          recordStopAnswer(stopOperationId, { kind: 'unanswerable' })
        }
      } finally {
        inFlight.current.delete(stopOperationId)
        setResends((current) => ({ ...current }))
      }
    },
    [recordStopAnswer, writeAs]
  )

  const owed = unansweredStop(outbox)
  const newer = owed !== null && newerSendExists(outbox, submissions, owed)
  useLayoutEffect(() => {
    if (owed !== null && newer) {
      recordStopAnswer(owed, { kind: 'unanswerable' })
    }
  }, [newer, owed, recordStopAnswer])

  useEffect(() => {
    if (owed === null || newer || !attached || inFlight.current.has(owed)) {
      return
    }
    const attempts = resends.id === owed ? resends.attempts : 0
    const timer = setTimeout(
      () => {
        setResends({ id: owed, attempts: attempts + 1 })
        void sendStop(owed, false)
      },
      Math.min(STOP_RESEND_BASE_DELAY_MS * 2 ** attempts, STOP_RESEND_MAX_DELAY_MS)
    )
    return () => clearTimeout(timer)
  }, [attached, newer, owed, resends, sendStop])

  return useCallback(async (): Promise<void> => {
    const stopOperationId = structuredSessionOperationId()
    stopOutbox(stopOperationId)
    await sendStop(stopOperationId, true)
  }, [sendStop, stopOutbox])
}
