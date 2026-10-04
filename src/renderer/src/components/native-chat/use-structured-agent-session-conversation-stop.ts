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

/** Whether a message was sent after this Stop was pressed. This app's own sends compare the time
 *  they were queued with the press, both on this machine's clock. Another client's are known only
 *  by the time in their id, made on that client's clock, so a skewed clock can misjudge them. */
function newerSendExists(
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  stopOperationId: string
): boolean {
  const pressedAt = parseAgentSessionOperationTimestamp(stopOperationId) ?? Infinity
  return (
    outbox.some((entry) => entry.queuedAt > pressedAt) ||
    submissions.some(
      (submission) =>
        (parseAgentSessionOperationTimestamp(submission.clientMessageId) ?? -Infinity) > pressedAt
    )
  )
}

/** Whether a Stop whose answer was lost goes again from the resend effect below. */
function stopWillBeResent(
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  stopOperationId: string
): boolean {
  return (
    outbox.some(
      (entry) =>
        entry.stoppedBy?.operationId === stopOperationId &&
        !entry.stoppedBy.cursor &&
        entry.stoppedBy.unanswerable !== true
    ) && !newerSendExists(outbox, submissions, stopOperationId)
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
  // The same set for rendering, so the effects below see a request end.
  const [inFlightIds, setInFlightIds] = useState<readonly string[]>([])
  const latest = useRef({ outbox, submissions })
  useLayoutEffect(() => {
    latest.current = { outbox, submissions }
  }, [outbox, submissions])
  const [resends, setResends] = useState<{ id: string | null; attempts: number }>({
    id: null,
    attempts: 0
  })
  // What a press left unsaid because its Stop would go again: said if the Stop is given up first.
  const quietPresses = useRef(new Map<string, string>())
  const sayQuietPress = useCallback((stopOperationId: string): void => {
    const notice = quietPresses.current.get(stopOperationId)
    quietPresses.current.delete(stopOperationId)
    if (notice !== undefined) {
      toast.error(notice)
    }
  }, [])

  const sendStop = useCallback(
    async (stopOperationId: string, firstPress: boolean): Promise<void> => {
      if (inFlight.current.has(stopOperationId)) {
        return
      }
      inFlight.current.add(stopOperationId)
      setInFlightIds((ids) => [...ids, stopOperationId])
      try {
        const outcome = await writeAs(
          stopOperationId,
          'agentSession.cancel',
          'agentSession.cancel',
          {}
        )
        if (outcome.kind === 'done') {
          quietPresses.current.delete(stopOperationId)
          recordStopAnswer(stopOperationId, { kind: 'answered', cursor: outcome.cursor })
          return
        }
        if (outcome.kind === 'dropped') {
          sayQuietPress(stopOperationId)
          recordStopAnswer(stopOperationId, { kind: 'unanswerable' })
          return
        }
        // A refusal is said on any attempt, a resend's too, and is the host's answer.
        if (outcome.answered) {
          quietPresses.current.delete(stopOperationId)
          toast.error(outcome.notice)
          recordStopAnswer(stopOperationId, { kind: 'unanswerable' })
          return
        }
        // A lost answer goes again from the effect below, so the press says it only when nothing
        // will, and otherwise keeps it for a Stop given up before an answer comes.
        if (firstPress) {
          if (
            stopWillBeResent(latest.current.outbox, latest.current.submissions, stopOperationId)
          ) {
            quietPresses.current.set(stopOperationId, outcome.notice)
          } else {
            toast.error(outcome.notice)
          }
        }
      } finally {
        inFlight.current.delete(stopOperationId)
        setInFlightIds((ids) => ids.filter((id) => id !== stopOperationId))
      }
    },
    [recordStopAnswer, sayQuietPress, writeAs]
  )

  const owed = unansweredStop(outbox)
  const newer = owed !== null && newerSendExists(outbox, submissions, owed)
  // Its request still out may yet be answered, so the stamp is only given up once it ends.
  const owedInFlight = owed !== null && inFlightIds.includes(owed)
  useLayoutEffect(() => {
    // Detached, a newer send this client saw proves nothing about the Stop the host may yet run.
    if (owed !== null && newer && !owedInFlight && attached) {
      sayQuietPress(owed)
      recordStopAnswer(owed, { kind: 'unanswerable' })
    }
  }, [attached, newer, owed, owedInFlight, recordStopAnswer, sayQuietPress])

  useEffect(() => {
    if (owed === null || newer || !attached || owedInFlight) {
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
  }, [attached, newer, owed, owedInFlight, resends, sendStop])

  return useCallback(async (): Promise<void> => {
    const stopOperationId = structuredSessionOperationId()
    stopOutbox(stopOperationId)
    await sendStop(stopOperationId, true)
  }, [sendStop, stopOutbox])
}
