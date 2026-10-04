// The one sender of an outbox entry, for the open chat's drain and a launch prompt alike, and the
// one place an answer changes the outbox: through the shared settlement
// (structured-agent-session-send-settlement).

import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../../shared/agent-session-wire'
import { readAgentSessionErrorRefusal } from '../../../../shared/agent-session-write-failure'
import { STRUCTURED_AGENT_SESSION_OUTBOX_NOT_SAVED } from '../../../../shared/structured-agent-session-send-failure-words'
import {
  applyStructuredAgentSessionSendSettlement,
  settleStructuredAgentSessionSendAnswer,
  type StructuredAgentSessionSendAnswer,
  type StructuredAgentSessionSendSettlement,
  type StructuredAgentSessionSettledOutbox
} from '../../../../shared/structured-agent-session-send-settlement'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { structuredAgentSessionHostAnswersProve } from '@/runtime/structured-agent-session-host-capability'
import {
  stageStructuredAgentSessionOutboxEntryForSend,
  structuredAgentSessionSendRequest,
  updateStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import {
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox,
  readOutbox
} from './structured-agent-session-outbox-storage'
import {
  getStructuredAgentLaunchPromptDispatch,
  shareStructuredAgentLaunchPromptDispatch
} from '@/lib/structured-agent-session-launch-prompt'
import {
  returnStructuredAgentSessionMessage,
  setStructuredAgentSessionChatLine
} from './structured-agent-session-returned-send'

type MutableRef<T> = { current: T }

export function hasInFlightLaunchDispatch(
  entry: StructuredAgentSessionOutboxEntry,
  fence: number | null
): boolean {
  return Boolean(
    entry.source === 'launch' &&
    getStructuredAgentLaunchPromptDispatch(
      entry.sessionId,
      entry.clientMessageId,
      fence ?? undefined
    )
  )
}

export function readMountedStructuredAgentSessionOutbox(
  sessionId: string,
  fence: number | null,
  read: (
    sessionId: string,
    options: { recoverDispatching: boolean }
  ) => StructuredAgentSessionOutboxEntry[]
): StructuredAgentSessionOutboxEntry[] {
  return read(sessionId, { recoverDispatching: false }).map((entry) =>
    entry.state === 'dispatching' && !hasInFlightLaunchDispatch(entry, fence)
      ? { ...entry, state: 'unconfirmed' as const }
      : entry
  )
}

/** A send left dispatching when its owner changed goes out again, under the same id. */
export function requeueInterruptedStructuredAgentSessionDispatches(
  entries: StructuredAgentSessionOutboxEntry[],
  fence: number | null
): StructuredAgentSessionOutboxEntry[] {
  return entries.map((entry) =>
    entry.state === 'dispatching' && entry.stoppedBy === undefined
      ? hasInFlightLaunchDispatch(entry, fence)
        ? entry
        : { ...entry, state: 'queued' as const }
      : entry
  )
}

/**
 * Commits a settlement: a message coming back goes to its conversation's draft before its entry
 * leaves the outbox, so a failure between the two repeats the text and never loses it.
 */
export function commitStructuredAgentSessionSettledOutbox(
  sessionId: string,
  settled: StructuredAgentSessionSettledOutbox
): void {
  if (settled.returned) {
    returnStructuredAgentSessionMessage(settled.returned.entry)
    if (settled.returned.words) {
      setStructuredAgentSessionChatLine(sessionId, settled.returned.words)
    }
  }
  commitStructuredAgentSessionOutbox(sessionId, settled.entries)
}

/** Settles one entry against the current outbox and commits it. */
export function settleStructuredAgentSessionOutboxEntry(
  sessionId: string,
  clientMessageId: string,
  settlement: StructuredAgentSessionSendSettlement
): void {
  const current = getStructuredAgentSessionOutbox(sessionId)
  const entry = current.find((candidate) => candidate.clientMessageId === clientMessageId)
  if (!entry) {
    return
  }
  // A send a Stop outran never goes again: no answer leaves it waiting for the Stop's.
  const kept =
    entry.stoppedBy !== undefined && settlement.kind === 'unanswered'
      ? { kind: 'pending' as const }
      : settlement
  commitStructuredAgentSessionSettledOutbox(
    sessionId,
    applyStructuredAgentSessionSendSettlement(current, clientMessageId, kept)
  )
}

/** Whether no attempt under this id has gone out from anywhere: read from storage too, which every
 *  window of this app shares, so one window's first attempt is never another's. */
function stagedAsFirstAttempt(entry: StructuredAgentSessionOutboxEntry): boolean {
  if (entry.lastAttemptAt !== null) {
    return false
  }
  const stored = readOutbox(entry.sessionId, { recoverDispatching: false }).find(
    (candidate) => candidate.clientMessageId === entry.clientMessageId
  )
  return stored === undefined || stored.lastAttemptAt === null
}

async function readSendAnswer(
  target: RuntimeClientTarget,
  entry: StructuredAgentSessionOutboxEntry,
  fence: number
): Promise<StructuredAgentSessionSendAnswer> {
  try {
    return {
      kind: 'result',
      result: await callStructuredAgentSession<AgentSessionMutationResult<AgentSessionSendResult>>(
        target,
        'agentSession.send',
        structuredAgentSessionSendRequest(entry, fence)
      )
    }
  } catch (caught) {
    return {
      kind: 'thrown',
      carriedRefusal: readAgentSessionErrorRefusal(caught) !== undefined,
      rpcCode: caught instanceof RuntimeRpcCallError ? caught.code : undefined
    }
  }
}

/**
 * Sends one entry and settles it by the answer. `isCurrent` says whether the answer still belongs
 * to the outbox that sent it (an owner change voids it; the entry then goes again under its id).
 * Resolves to the settlement, or null when the answer was voided or the entry could not be staged.
 */
export async function sendStructuredAgentSessionOutboxEntry(args: {
  /** The request's own copy; `entries` holds the copy to stage. */
  next: StructuredAgentSessionOutboxEntry
  entries: readonly StructuredAgentSessionOutboxEntry[]
  target: RuntimeClientTarget
  fence: number
  isCurrent: () => boolean
  /** Whether the loaded journal holds a row for the id; absent where no journal is loaded. */
  journalHasRow?: (clientMessageId: string) => boolean
}): Promise<StructuredAgentSessionSendSettlement | null> {
  const { next } = args
  const sessionId = next.sessionId
  const firstAttempt = stagedAsFirstAttempt(next)
  const staged = updateStructuredAgentSessionOutboxEntry(
    args.entries,
    next.clientMessageId,
    (entry) => stageStructuredAgentSessionOutboxEntryForSend(entry, Date.now())
  )
  if (!commitStructuredAgentSessionOutbox(sessionId, staged, { onlyIfSaved: true })) {
    // Unsaved, a send could go out that a reload never settles; it comes back instead.
    settleStructuredAgentSessionOutboxEntry(sessionId, next.clientMessageId, {
      kind: 'returned',
      words: [...STRUCTURED_AGENT_SESSION_OUTBOX_NOT_SAVED]
    })
    return null
  }
  const answer = await readSendAnswer(args.target, next, args.fence)
  if (!args.isCurrent()) {
    return null
  }
  // Only a resend's refusal reads the host's proof; asked after the answer, so a send never waits
  // on it, and a first attempt's refusal proves no record on any host.
  const answersProve =
    !firstAttempt && answer.kind === 'result' && !answer.result.ok
      ? await structuredAgentSessionHostAnswersProve(args.target)
      : false
  if (!args.isCurrent()) {
    return null
  }
  const settlement = settleStructuredAgentSessionSendAnswer(answer, next.clientMessageId, {
    firstAttempt,
    answersProve,
    journalHasRow: args.journalHasRow?.(next.clientMessageId) ?? false
  })
  settleStructuredAgentSessionOutboxEntry(sessionId, next.clientMessageId, settlement)
  return settlement
}

/** The open chat's drain: one send at a time, released as part of the write that settles it. */
export function dispatchStructuredAgentSessionOutboxEntry(args: {
  next: StructuredAgentSessionOutboxEntry
  /** The outbox to stage `next` in: the latest. */
  entries: readonly StructuredAgentSessionOutboxEntry[]
  sessionId: string
  target: RuntimeClientTarget
  fence: number
  dispatchGeneration: number
  dispatchGenerationRef: MutableRef<number>
  inFlightIdRef: MutableRef<string | null>
  journalHasRow: (clientMessageId: string) => boolean
}): { promise: Promise<boolean>; started: boolean } {
  const start = async (): Promise<boolean> => {
    args.inFlightIdRef.current = args.next.clientMessageId
    const isCurrent = (): boolean => args.dispatchGenerationRef.current === args.dispatchGeneration
    const release = (): void => {
      if (isCurrent() && args.inFlightIdRef.current === args.next.clientMessageId) {
        args.inFlightIdRef.current = null
      }
    }
    const settlement = await sendStructuredAgentSessionOutboxEntry({
      next: args.next,
      entries: args.entries,
      target: args.target,
      fence: args.fence,
      journalHasRow: args.journalHasRow,
      // Released before the settling write, which is what runs the drain again.
      isCurrent: () => {
        const current = isCurrent()
        if (current) {
          release()
        }
        return current
      }
    })
    release()
    return settlement?.kind === 'recorded' || settlement?.kind === 'pending'
  }
  return args.next.source === 'launch'
    ? shareStructuredAgentLaunchPromptDispatch(
        args.next.sessionId,
        args.next.clientMessageId,
        args.fence,
        start
      )
    : { promise: start(), started: true }
}
