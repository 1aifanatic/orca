// The one sender of an outbox entry, for the open chat's drain and a launch prompt alike, and the
// one place an answer changes the outbox: through the shared settlement
// (structured-agent-session-send-settlement).

import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../../shared/agent-session-wire'
import {
  agentSessionRefusalFailure,
  readAgentSessionErrorRefusal
} from '../../../../shared/agent-session-write-failure'
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
} from '@/lib/structured-agent-launch-prompt-in-flight-dispatches'
import {
  endStructuredAgentSessionEntry,
  type StructuredAgentSessionEntryEnding
} from './structured-agent-session-entry-endings'
import {
  clearStructuredAgentSessionChatLineHeldBy,
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

/** What the chat line says once a settlement is committed: why a message is still being sent, said
 *  once, until it settles. A returned message's words are set as it comes back. */
export function sayStructuredAgentSessionSettlement(
  sessionId: string,
  clientMessageId: string,
  settlement: StructuredAgentSessionSendSettlement
): void {
  if (settlement.kind === 'unanswered') {
    if (settlement.words) {
      setStructuredAgentSessionChatLine(sessionId, settlement.words, clientMessageId)
    }
    return
  }
  if (settlement.kind !== 'returned') {
    clearStructuredAgentSessionChatLineHeldBy(sessionId, clientMessageId)
  }
}

/** How a settlement ends its entry for whoever waits on it, or null while it has not ended. */
export function structuredAgentSessionSettlementEnding(
  settlement: StructuredAgentSessionSendSettlement
): StructuredAgentSessionEntryEnding | null {
  switch (settlement.kind) {
    case 'recorded':
    case 'pending':
      return 'delivered'
    case 'returned':
    case 'withdrawn':
      return 'notDelivered'
    case 'unanswered':
      return null
  }
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
  const ending = structuredAgentSessionSettlementEnding(settlement)
  if (ending) {
    endStructuredAgentSessionEntry(sessionId, clientMessageId, ending)
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
  sayStructuredAgentSessionSettlement(sessionId, clientMessageId, kept)
}

function storedEntry(
  entry: StructuredAgentSessionOutboxEntry
): StructuredAgentSessionOutboxEntry | undefined {
  return readOutbox(entry.sessionId, { recoverDispatching: false }).find(
    (candidate) => candidate.clientMessageId === entry.clientMessageId
  )
}

/** Whether no attempt under this id has gone out from anywhere: read from storage too, which every
 *  window of this app shares, so one window's first attempt is never another's. */
function stagedAsFirstAttempt(entry: StructuredAgentSessionOutboxEntry): boolean {
  if (entry.lastAttemptAt !== null) {
    return false
  }
  const stored = storedEntry(entry)
  return stored === undefined || stored.lastAttemptAt === null
}

/** Whether this attempt is still the only one: another view or window that staged the id again
 *  meanwhile restamped it in storage, and its attempt may land whatever this one was told. */
function stillOnlyAttempt(entry: StructuredAgentSessionOutboxEntry, stagedAt: number): boolean {
  return storedEntry(entry)?.lastAttemptAt === stagedAt
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
    const refusal = readAgentSessionErrorRefusal(caught)
    return {
      kind: 'thrown',
      refusal: refusal ? agentSessionRefusalFailure(refusal) : undefined,
      rpcCode: caught instanceof RuntimeRpcCallError ? caught.code : undefined
    }
  }
}

/**
 * Sends one entry and settles it by the answer. `isCurrent` says whether the answer still belongs
 * to the outbox that sent it (an owner change voids it; the entry then goes again under its id);
 * `beforeSettle` runs just before the write that settles it. Resolves to the settlement, or null
 * when the answer was voided.
 */
export async function sendStructuredAgentSessionOutboxEntry(args: {
  /** The request's own copy; `entries` holds the copy to stage. */
  next: StructuredAgentSessionOutboxEntry
  entries: readonly StructuredAgentSessionOutboxEntry[]
  target: RuntimeClientTarget
  fence: number
  isCurrent: () => boolean
  beforeSettle?: () => void
  /** Whether the loaded journal holds a row for the id; absent where no journal is loaded. */
  journalHasRow?: (clientMessageId: string) => boolean
}): Promise<StructuredAgentSessionSendSettlement | null> {
  const { next } = args
  const sessionId = next.sessionId
  const settle = (settlement: StructuredAgentSessionSendSettlement): void => {
    args.beforeSettle?.()
    settleStructuredAgentSessionOutboxEntry(sessionId, next.clientMessageId, settlement)
  }
  const stagedAt = Date.now()
  const staged = updateStructuredAgentSessionOutboxEntry(
    args.entries,
    next.clientMessageId,
    (entry) => stageStructuredAgentSessionOutboxEntryForSend(entry, stagedAt)
  )
  const firstAttempt = stagedAsFirstAttempt(next)
  if (!commitStructuredAgentSessionOutbox(sessionId, staged, { onlyIfSaved: true })) {
    // Unsaved, a send could go out that a reload never settles, and handing it back could repeat
    // one an earlier attempt landed: it waits, and the probe tries again.
    const unsaved: StructuredAgentSessionSendSettlement = {
      kind: 'unanswered',
      words: ['messageNotSaved']
    }
    settle(unsaved)
    return unsaved
  }
  const answer = await readSendAnswer(args.target, next, args.fence)
  if (!args.isCurrent()) {
    return null
  }
  // Only a resend's refusal reads the host's proof; asked after the answer, so a send never waits
  // on it, and a first attempt's refusal proves no record on any host.
  const onlyAttempt = firstAttempt && stillOnlyAttempt(next, stagedAt)
  const answersProve =
    !onlyAttempt && answer.kind === 'result' && !answer.result.ok
      ? await structuredAgentSessionHostAnswersProve(args.target)
      : false
  if (!args.isCurrent()) {
    return null
  }
  const settlement = settleStructuredAgentSessionSendAnswer(answer, next.clientMessageId, {
    firstAttempt: onlyAttempt,
    answersProve,
    journalHasRow: args.journalHasRow?.(next.clientMessageId) ?? false
  })
  settle(settlement)
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
}): { promise: Promise<StructuredAgentSessionSendSettlement | null>; started: boolean } {
  const start = async (): Promise<StructuredAgentSessionSendSettlement | null> => {
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
      isCurrent,
      // Held through the capability probe, so nothing overtakes it; released before the settling
      // write, which is what runs the drain again.
      beforeSettle: release
    })
    release()
    return settlement
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
