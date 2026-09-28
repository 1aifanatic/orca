import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import {
  admitStructuredAgentSessionOutboxEntry,
  createStructuredAgentSessionOutboxEntry,
  reconcileStructuredAgentSessionOutbox,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import {
  journalAnswersInFlightSend,
  type StructuredAgentSessionSendDisposition
} from '../../../../shared/structured-agent-session-send-disposition'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { readOutbox, writeOutbox } from './structured-agent-session-outbox-storage'
import {
  dispatchStructuredAgentSessionOutboxEntry,
  readMountedStructuredAgentSessionOutbox,
  requeueInterruptedStructuredAgentSessionDispatches
} from './structured-agent-session-outbox-dispatch'
import { getStructuredAgentLaunchPromptDispatch } from '@/lib/structured-agent-session-launch-prompt'
import { useStructuredAgentSessionOutboxOwnerChange } from '@/runtime/structured-agent-session-accepted-send-capability'
import { useStructuredAgentSessionOutboxUnconfirmedProbe } from './use-structured-agent-session-outbox-unconfirmed-probe'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useStructuredAgentSessionWithdrawnRestore } from './structured-agent-session-withdrawn-message-restore'
import { useStructuredAgentSessionOutboxOwnership } from './use-structured-agent-session-outbox-ownership'
import { retryStructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox-retry'

export function structuredSessionOperationId(): string {
  return createStructuredAgentSessionOperationId(createBrowserUuid)
}

export function useStructuredAgentSessionOutbox(args: {
  sessionId: string
  target: RuntimeClientTarget
  fence: number | null
  submissions: readonly AgentJournalSubmission[]
  /** The composer that gets back what a Stop withdrew from this client's outbox. */
  composerScopeKey?: string
  /** Stamp new sends `delivery: 'queue-if-active'` (capable host + setting on); the host
   *  holds one as a draft only while the agent is working. */
  queueDelivery?: boolean
  /** Ids of the host's published drafts. A queued send whose acknowledgement was lost keeps
   *  its entry here under the draft's own id; once the host visibly holds the draft, the
   *  entry retires so the same text can never come back twice. */
  queuedMessageIds?: readonly string[]
}) {
  const {
    composerScopeKey,
    fence,
    queueDelivery = false,
    queuedMessageIds,
    sessionId,
    submissions,
    target
  } = args
  // What resends, unblocks and drops a send in flight besides a Retry or a new send; see the hook.
  const owner = useStructuredAgentSessionOutboxOwnerChange(target, fence)
  const restoreWithdrawn = useStructuredAgentSessionWithdrawnRestore(sessionId, composerScopeKey)
  const [outbox, setOutbox] = useState<StructuredAgentSessionOutboxEntry[]>(() =>
    readMountedStructuredAgentSessionOutbox(sessionId, fence, readOutbox)
  )
  const outboxRef = useRef(outbox)
  const outboxSessionRef = useRef(sessionId)
  // The entry whose send is in flight, or null. One ref, because "is something in flight" and
  // "which entry" must never disagree: the journal can settle the tail while the head moves.
  const inFlightIdRef = useRef<string | null>(null)
  const dispatchGenerationRef = useRef(0)
  const blockedIdRef = useRef<string | null>(null)
  const retryWithFreshClientMessageIdRef = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorSession, setErrorSession] = useState(sessionId)
  // Render-time reset (react.dev: adjusting state when a prop changes), so the
  // old session's banner neither flashes for a frame nor resurrects on return.
  if (errorSession !== sessionId) {
    setErrorSession(sessionId)
    setError(null)
  }

  useEffect(() => {
    outboxRef.current = outbox
  }, [outbox])

  useLayoutEffect(() => {
    dispatchGenerationRef.current += 1
    inFlightIdRef.current = null
    blockedIdRef.current = null
    retryWithFreshClientMessageIdRef.current = null
  }, [owner.ownerChange, owner.targetKey, sessionId])

  useEffect(() => {
    const sessionChanged = outboxSessionRef.current !== sessionId
    outboxSessionRef.current = sessionId
    const current = sessionChanged
      ? readMountedStructuredAgentSessionOutbox(sessionId, owner.fenceRef.current, readOutbox)
      : outboxRef.current
    const next = requeueInterruptedStructuredAgentSessionDispatches(current, owner.fenceRef.current)
    if (
      sessionChanged ||
      next.some((entry, index) => entry !== current[index]) ||
      next.length !== current.length
    ) {
      outboxRef.current = next
      setOutbox(next)
      writeOutbox(sessionId, next)
    }
  }, [owner.fenceRef, owner.ownerChange, sessionId, target])

  useEffect(() => {
    const current = outboxRef.current
    const hostOwns = new Set(
      submissions
        .filter(
          (submission) =>
            submission.dispatchState === 'pending' || submission.dispatchState === 'accepted'
        )
        .map((submission) => submission.clientMessageId)
    )
    const next = reconcileStructuredAgentSessionOutbox(current, submissions)
    const admittedInFlight = journalAnswersInFlightSend(submissions, inFlightIdRef.current)
    if (
      admittedInFlight ||
      next.some((entry, index) => entry !== current[index]) ||
      next.length !== current.length
    ) {
      restoreWithdrawn.byHost(current, submissions)
      outboxRef.current = next
      setOutbox(next)
      writeOutbox(sessionId, next)
    }
    // Keyed on the entry actually in flight, which is no longer always the head: the journal
    // owning it outranks a send promise that has not settled, so release single-flight and make
    // that promise a no-op. Keying on the head would discard the tail's unsettled send instead,
    // and with it a refusal only that send can report.
    if (admittedInFlight) {
      dispatchGenerationRef.current += 1
      inFlightIdRef.current = null
    }
    if (blockedIdRef.current !== null && hostOwns.has(blockedIdRef.current)) {
      blockedIdRef.current = null
      setError(null)
    } else if (
      current.some((entry) => entry.state === 'unconfirmed' && hostOwns.has(entry.clientMessageId))
    ) {
      setError(null)
    }
  }, [restoreWithdrawn, sessionId, submissions])

  // The one place that owns the refs, the React state and the storage write.
  const applyDisposition = useCallback(
    (disposition: StructuredAgentSessionSendDisposition): void => {
      // Released here rather than in a `.finally`: the state write below is what re-runs the
      // drain, so a later microtask would leave the queue with no trigger to move on.
      inFlightIdRef.current = null
      blockedIdRef.current = disposition.blockedClientMessageId
      retryWithFreshClientMessageIdRef.current = disposition.retryWithFreshClientMessageId
      setError(disposition.error)
      outboxRef.current = disposition.entries
      setOutbox(disposition.entries)
      writeOutbox(sessionId, disposition.entries)
    },
    [sessionId]
  )

  useEffect(() => {
    const head = outbox[0]
    if (!head || head.sessionId !== sessionId) {
      return
    }
    const mirrorPersisted = (): void => {
      const latest = readOutbox(sessionId, { recoverDispatching: false })
      outboxRef.current = latest
      setOutbox(latest)
    }
    // A launch settlement dispatches outside this hook's single-flight, so while its send is up
    // nothing else may go out beside it and race it for the host's arrival order.
    const launching = outbox.find((entry) => entry.source === 'launch')
    const launchDispatch = launching
      ? getStructuredAgentLaunchPromptDispatch(
          launching.sessionId,
          launching.clientMessageId,
          fence ?? undefined
        )
      : undefined
    if (launching && launchDispatch) {
      const persisted = readOutbox(sessionId, { recoverDispatching: false })
      const persistedLaunch = persisted.find(
        (entry) => entry.clientMessageId === launching.clientMessageId
      )
      if (persistedLaunch?.state !== launching.state) {
        outboxRef.current = persisted
        setOutbox(persisted)
      }
      void launchDispatch.then(mirrorPersisted)
      return
    }
    const admission = admitStructuredAgentSessionOutboxEntry(outbox, blockedIdRef.current)
    if (admission.state !== 'dispatch' || fence === null || inFlightIdRef.current !== null) {
      return
    }
    const next = admission.entry
    // A launch settlement may have already admitted this entry and cleared its in-flight marker
    // before this effect observes the queued React snapshot. Storage is the shared ownership
    // record; only dispatch when the persisted entry is still queued.
    const persisted = readOutbox(sessionId, { recoverDispatching: false })
    const persistedEntry = persisted.find((entry) => entry.clientMessageId === next.clientMessageId)
    if (persistedEntry?.state !== 'queued') {
      outboxRef.current = persisted
      setOutbox(persisted)
      return
    }
    const dispatchGeneration = dispatchGenerationRef.current
    const dispatch = dispatchStructuredAgentSessionOutboxEntry({
      next: persistedEntry,
      persisted,
      sessionId,
      target,
      fence,
      dispatchGeneration,
      dispatchGenerationRef,
      inFlightIdRef,
      blockedIdRef,
      outboxRef,
      setOutbox,
      setError,
      applyDisposition,
      createOperationId: structuredSessionOperationId
    })
    if (!dispatch.started) {
      // The launch settlement owns this entry. Its storage mutation does not update this hook's
      // local state, so mirror the settled state once the shared admission finishes.
      void dispatch.promise.then(mirrorPersisted)
    }
  }, [applyDisposition, fence, outbox, sessionId, target])

  useStructuredAgentSessionOutboxUnconfirmedProbe({
    sessionId,
    outbox,
    submissions,
    owner,
    outboxRef,
    setOutbox
  })

  const send = useCallback(
    (text: string, attachments: readonly { path: string; previewUri: string }[] = []): boolean => {
      if (!text.trim() && attachments.length === 0) {
        return false
      }
      const entry = createStructuredAgentSessionOutboxEntry({
        clientMessageId: structuredSessionOperationId(),
        sessionId,
        text,
        attachments,
        queuedAt: Date.now(),
        // Text-only: an image send keeps today's immediate path (host routes it there anyway).
        ...(queueDelivery && attachments.length === 0
          ? { delivery: 'queue-if-active' as const }
          : {})
      })
      const next = [...outboxRef.current, entry]
      if (!writeOutbox(sessionId, next)) {
        setError('Message could not be saved to the outbox')
        return false
      }
      outboxRef.current = next
      setOutbox(next)
      setError(null)
      return true
    },
    [queueDelivery, sessionId]
  )

  const { retire, withdrawUnsent } = useStructuredAgentSessionOutboxOwnership({
    sessionId,
    submissions,
    queuedMessageIds,
    outboxRef,
    blockedIdRef,
    setOutbox,
    restoreWithdrawn
  })

  const retry = (clientMessageId: string): void => {
    blockedIdRef.current = null
    setError(null)
    retryStructuredAgentSessionOutboxEntry({
      clientMessageId,
      sessionId,
      submissions,
      outboxRef,
      retryWithFreshClientMessageIdRef,
      setOutbox,
      setError,
      createOperationId: structuredSessionOperationId
    })
  }
  return {
    outbox,
    error,
    blockedClientMessageId: blockedIdRef.current,
    send,
    retry,
    retire,
    withdrawUnsent
  }
}
