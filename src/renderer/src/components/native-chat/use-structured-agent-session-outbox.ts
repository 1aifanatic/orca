import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import { admitStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox-admission'
import { STRUCTURED_AGENT_SESSION_OUTBOX_NOT_SAVED } from '../../../../shared/structured-agent-session-send-failure-words'
import { stopStructuredAgentSessionOutbox } from '../../../../shared/structured-agent-session-outbox-stop-withdrawal'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  appendStructuredAgentSessionOutboxMessage,
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox,
  loadStructuredAgentSessionOutbox,
  readOutbox,
  subscribeToStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'
import {
  dispatchStructuredAgentSessionOutboxEntry,
  readMountedStructuredAgentSessionOutbox,
  requeueInterruptedStructuredAgentSessionDispatches
} from './structured-agent-session-outbox-dispatch'
import {
  nextStructuredAgentSessionHostWindowEnd,
  settleStructuredAgentSessionOutboxFromJournal
} from './structured-agent-session-outbox-journal-settlement'
import { getStructuredAgentLaunchPromptDispatch } from '@/lib/structured-agent-session-launch-prompt'
import { useStructuredAgentSessionOutboxOwnerChange } from '@/runtime/structured-agent-session-accepted-send-capability'
import { useStructuredAgentSessionOutboxUnconfirmedProbe } from './use-structured-agent-session-outbox-unconfirmed-probe'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  returnStructuredAgentSessionMessage,
  setStructuredAgentSessionChatLine,
  useStructuredAgentSessionChatLine
} from './structured-agent-session-returned-send'
import {
  structuredAgentSessionEntryAttempt,
  type StructuredAgentSessionQueueDelivery
} from '../../../../shared/structured-agent-session-outbox-delivery'

/** setTimeout's longest delay; a longer wait fires early and is simply armed again. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

const NO_QUEUE_DELIVERY: StructuredAgentSessionQueueDelivery = {
  capability: 'unsupported',
  enabled: false
}

export function structuredSessionOperationId(): string {
  return createStructuredAgentSessionOperationId(createBrowserUuid)
}

/** What a Stop's request got back, for the sends it outran. */
export type StructuredAgentSessionStopAnswer =
  /** The host ran it: where its journal stood. */
  | { kind: 'answered'; cursor: AgentJournalCursor }
  /** The host refused it, or it can't be sent again without stopping something newer. */
  | { kind: 'unanswerable' }

export function useStructuredAgentSessionOutbox(args: {
  sessionId: string
  target: RuntimeClientTarget
  fence: number | null
  submissions: readonly AgentJournalSubmission[]
  /** How far the journal has been read; null until a page has loaded. */
  journalCursor?: AgentJournalCursor | null
  /** The host's queued-messages capability and the user's setting; a send stamped
   *  `delivery: 'queue-if-active'` is held as a draft only while the agent is working. */
  queueDelivery?: StructuredAgentSessionQueueDelivery
  /** Ids of the host's published drafts, or undefined before it publishes a list. An entry under
   *  one of these ids belongs to the host: its card carries the text. */
  queuedMessageIds?: readonly string[]
}) {
  const {
    fence,
    journalCursor = null,
    queueDelivery = NO_QUEUE_DELIVERY,
    queuedMessageIds,
    sessionId,
    submissions,
    target
  } = args
  const { capability: queueCapability, enabled: queueEnabled } = queueDelivery
  // What resends and drops a send in flight besides a new send; see the hook.
  const owner = useStructuredAgentSessionOutboxOwnerChange(target, fence)
  // The outbox lives in the session's store, shared with every other writer; this view holds it
  // open and drains it. Loading maps what a previous owner left mid-send.
  const load = useCallback(
    () => readMountedStructuredAgentSessionOutbox(sessionId, fence, readOutbox),
    // Why: only the load at open reads the fence; later fences must not re-create the hold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId]
  )
  const subscribe = useCallback(
    (listener: () => void) => subscribeToStructuredAgentSessionOutbox(sessionId, load, listener),
    [load, sessionId]
  )
  const outbox = useSyncExternalStore(subscribe, () =>
    loadStructuredAgentSessionOutbox(sessionId, load)
  )
  const outboxSessionRef = useRef(sessionId)
  // The entry whose send is in flight, or null. One ref, because "is something in flight" and
  // "which entry" must never disagree: the journal can settle the tail while the head moves.
  const inFlightIdRef = useRef<string | null>(null)
  const dispatchGenerationRef = useRef(0)
  const submissionsRef = useRef(submissions)
  useLayoutEffect(() => {
    submissionsRef.current = submissions
  }, [submissions])
  const error = useStructuredAgentSessionChatLine(sessionId)

  useLayoutEffect(() => {
    dispatchGenerationRef.current += 1
    inFlightIdRef.current = null
  }, [owner.ownerChange, owner.targetKey, sessionId])

  useEffect(() => {
    const sessionChanged = outboxSessionRef.current !== sessionId
    outboxSessionRef.current = sessionId
    const current = getStructuredAgentSessionOutbox(sessionId)
    const next = requeueInterruptedStructuredAgentSessionDispatches(current, owner.fenceRef.current)
    if (
      sessionChanged ||
      next.some((entry, index) => entry !== current[index]) ||
      next.length !== current.length
    ) {
      commitStructuredAgentSessionOutbox(sessionId, next)
    }
  }, [owner.fenceRef, owner.ownerChange, sessionId, target])

  const [drains, setDrains] = useState(0)
  const drainAgain = useCallback(() => setDrains((count) => count + 1), [])

  // Everything the journal settles, every time it or the outbox moves: a row, a published card, the
  // Stop's answer read through, or an entry an older build left. The outbox too, since an idle
  // Stop answers at a cursor the journal already reached, and nothing else would move.
  const [hostWindowsClosed, setHostWindowsClosed] = useState(0)
  useEffect(() => {
    const now = Date.now()
    const reading = {
      submissions,
      cursor: journalCursor,
      inFlightClientMessageId: inFlightIdRef.current,
      queuedMessageIds: queuedMessageIds ?? null,
      now
    }
    const entries = settleStructuredAgentSessionOutboxFromJournal(sessionId, reading)
    // The host holding the send in flight outranks a reply that has not come: release
    // single-flight and void that reply, keyed on the entry actually in flight.
    const inFlight = inFlightIdRef.current
    if (
      inFlight !== null &&
      (submissions.some(
        (submission) =>
          submission.clientMessageId === inFlight || submission.queuedMessageId === inFlight
      ) ||
        queuedMessageIds?.includes(inFlight) === true)
    ) {
      dispatchGenerationRef.current += 1
      inFlightIdRef.current = null
      // Nothing above may have written the outbox, so the drain is told to look again.
      drainAgain()
    }
    // A send only an owed answer settles must still end when the host's window for it closes,
    // though nothing else moves by then.
    const windowEnd = nextStructuredAgentSessionHostWindowEnd(entries)
    if (windowEnd === null) {
      return
    }
    const timer = setTimeout(
      () => setHostWindowsClosed((count) => count + 1),
      Math.min(Math.max(windowEnd - now + 1, 0), MAX_TIMER_DELAY_MS)
    )
    return () => clearTimeout(timer)
  }, [
    drainAgain,
    hostWindowsClosed,
    journalCursor,
    outbox,
    queuedMessageIds,
    sessionId,
    submissions
  ])

  const journalHasRow = useCallback(
    (clientMessageId: string) =>
      submissionsRef.current.some((submission) => submission.clientMessageId === clientMessageId),
    []
  )

  useEffect(() => {
    // The shared outbox, not this render's copy: an effect earlier in this commit (an owner
    // change's requeue, a reconcile) or a launch settlement may have written a newer one.
    const current = getStructuredAgentSessionOutbox(sessionId)
    const head = current[0]
    if (!head || head.sessionId !== sessionId) {
      return
    }
    // A launch settlement sends through the same sender outside this hook's single-flight, so
    // while its send is up nothing else may go out beside it and race it for the host's arrival
    // order. Drain again once it settles.
    const launching = current.find((entry) => entry.source === 'launch')
    const launchDispatch = launching
      ? getStructuredAgentLaunchPromptDispatch(
          launching.sessionId,
          launching.clientMessageId,
          fence ?? undefined
        )
      : undefined
    if (launchDispatch) {
      void launchDispatch.then(drainAgain, drainAgain)
      return
    }
    const admission = admitStructuredAgentSessionOutboxEntry(current)
    if (admission.state !== 'dispatch' || fence === null || inFlightIdRef.current !== null) {
      return
    }
    const next = admission.entry
    // The request reads the capability; the entry keeps only what its first attempt sent.
    const attempt = structuredAgentSessionEntryAttempt(next, {
      capability: queueCapability,
      enabled: queueEnabled
    })
    const dispatch = dispatchStructuredAgentSessionOutboxEntry({
      next: attempt.wire,
      entries: current.map((entry) => (entry === next ? attempt.stored : entry)),
      sessionId,
      target,
      fence,
      dispatchGeneration: dispatchGenerationRef.current,
      dispatchGenerationRef,
      inFlightIdRef,
      journalHasRow
    })
    // Whatever settles it writes the outbox, which runs this again; an unsaved stage or a voided
    // answer writes nothing, so drain again when it ends either way.
    void dispatch.promise.then(drainAgain, drainAgain)
  }, [
    drainAgain,
    drains,
    fence,
    journalHasRow,
    outbox,
    queueCapability,
    queueEnabled,
    sessionId,
    target
  ])

  useStructuredAgentSessionOutboxUnconfirmedProbe({
    sessionId,
    outbox,
    submissions,
    owner
  })

  const send = useCallback(
    (text: string, attachments: readonly { path: string; previewUri: string }[] = []): boolean => {
      if (!text.trim() && attachments.length === 0) {
        return false
      }
      // Whether it asks to be queued is decided when it first goes out.
      if (!appendStructuredAgentSessionOutboxMessage(sessionId, text, attachments)) {
        setStructuredAgentSessionChatLine(sessionId, STRUCTURED_AGENT_SESSION_OUTBOX_NOT_SAVED)
        return false
      }
      setStructuredAgentSessionChatLine(sessionId, null)
      return true
    },
    [sessionId]
  )

  /** A Stop's local step, before its request: what never went out comes back to the composer, and
   *  what is on its way is stamped with the Stop's id so nothing sends it again. */
  const stop = useCallback(
    (stopOperationId: string): void => {
      const current = getStructuredAgentSessionOutbox(sessionId)
      const next = stopStructuredAgentSessionOutbox(
        current,
        submissionsRef.current,
        inFlightIdRef.current,
        stopOperationId
      )
      if (next.withdrawn.length === 0 && next.entries.every((entry, i) => entry === current[i])) {
        return
      }
      for (const entry of next.withdrawn) {
        returnStructuredAgentSessionMessage(entry)
      }
      commitStructuredAgentSessionOutbox(sessionId, next.entries)
    },
    [sessionId]
  )

  /** Records the Stop's answer on the sends it outran; the journal settles them from there. */
  const recordStopAnswer = useCallback(
    (stopOperationId: string, answer: StructuredAgentSessionStopAnswer): void => {
      const current = getStructuredAgentSessionOutbox(sessionId)
      let changed = false
      const next = current.map((entry) => {
        if (entry.stoppedBy?.operationId !== stopOperationId || entry.stoppedBy.cursor) {
          return entry
        }
        changed = true
        return {
          ...entry,
          stoppedBy:
            answer.kind === 'answered'
              ? { operationId: stopOperationId, cursor: answer.cursor }
              : { operationId: stopOperationId, unanswerable: true as const }
        }
      })
      if (changed) {
        commitStructuredAgentSessionOutbox(sessionId, next)
      }
    },
    [sessionId]
  )

  return {
    outbox,
    error,
    send,
    stop,
    recordStopAnswer
  }
}
