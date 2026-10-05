// A command sent while a message from this window is still on its way to the host waits for that
// message quietly, so it reaches the host behind it. Derived from the outbox on every change: no
// stored latch, and nothing outlives the pane.

import { useCallback, useEffect, useRef } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { hasUnsentStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox-stop-withdrawal'

/** Resolves true once none of the messages unsent at the call still owes a send of its own:
 *  the host has it, it awaits the user's Retry, or it left the outbox. False if the pane
 *  unmounts first. */
export function useStructuredConversationCommandHold(
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[]
): () => Promise<boolean> {
  const latest = useRef({ outbox, submissions })
  const waiters = useRef(new Set<(mounted: boolean) => void>())
  useEffect(() => {
    latest.current = { outbox, submissions }
    for (const wake of waiters.current) {
      wake(true)
    }
  }, [outbox, submissions])
  useEffect(() => {
    const pending = waiters.current
    return () => {
      for (const wake of pending) {
        wake(false)
      }
    }
  }, [])
  return useCallback(() => {
    const ahead = new Set(latest.current.outbox.map((entry) => entry.clientMessageId))
    const owesSend = (): boolean =>
      hasUnsentStructuredAgentSessionOutboxEntry(
        latest.current.outbox.filter((entry) => ahead.has(entry.clientMessageId)),
        latest.current.submissions
      )
    if (!owesSend()) {
      return Promise.resolve(true)
    }
    return new Promise<boolean>((resolve) => {
      const wake = (mounted: boolean): void => {
        if (mounted && owesSend()) {
          return
        }
        waiters.current.delete(wake)
        resolve(mounted)
      }
      waiters.current.add(wake)
    })
  }, [])
}
