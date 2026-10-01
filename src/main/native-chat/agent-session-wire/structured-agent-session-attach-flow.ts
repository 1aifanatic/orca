import { refuse } from '../../../shared/agent-session-wire-refusals'
import { settlePostAcquisitionAttachFailure } from './structured-agent-session-attach-failure'
import {
  failedAcquisitionRefusal,
  preSpawnFailureInWords
} from './structured-agent-session-failed-create-refusal'
import {
  isReplayedCreateAtRest,
  settleFailedStartOfReservation
} from './structured-agent-session-create-at-rest'
import type {
  StructuredAgentSessionAdapter,
  StructuredAgentSessionProviderChildPhase
} from './structured-agent-session-adapter'
// The host supplies owner authority; this flow reserves, proves, and publishes the session.

import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  admitAttachOrRefuse,
  attachJournal,
  classifyStoreFailure,
  journalIdentityFor,
  reserveRequestFor,
  type AgentSessionAttachAuthority,
  type AgentSessionAttachParams,
  type AttachedJournal
} from './structured-agent-session-attach'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { adapterSupportsCreateIfDeclared } from './structured-agent-session-provider-support'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { resolveAgentSessionReplayOutcome } from './structured-agent-session-replay-outcome'
import { readAgentSessionHydrationPage } from './agent-session-history-page'
import { acquireOwner } from './structured-agent-session-acquisition'
import {
  importAdoptedTranscript,
  prepareAdoptedTranscript
} from './structured-agent-session-adopted-import'
import {
  withAgentSessionCreatePhase,
  type AgentSessionCreatePhaseRecorder
} from '../../observability/agent-session-instrumentation'
import type { ProviderHistoryWindow } from '../agent-session-journal/journal-submission-reconciler'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export type AttachFlowInput = {
  store: AgentSessionRecordStore
  adapter: StructuredAgentSessionAdapter
  authority: AgentSessionAttachAuthority
  callerKey: string
  params: AgentSessionAttachParams
  now: () => number
  recordPhase?: AgentSessionCreatePhaseRecorder
  /** Publishes the journal before clients can send against the new owner. `acquiredOwner` is
   *  true only when this attach spawned the provider child, so a re-attach to a live one is not
   *  mistaken for a cold acquire. A null phase is a chat at rest: it has no child at all. */
  onAttached: (
    attached: AttachedJournal,
    acquisitionGeneration: string | null,
    acquiredOwner: boolean,
    providerChildPhase: StructuredAgentSessionProviderChildPhase | null
  ) => Promise<void> | void
  /** Host-owned provider sink, bound to the journal inside `onAttached`. */
  eventSink?: StructuredAgentSessionEventSink
  /** Stops acquisition-window events targeting the superseded journal. */
  onAcquiring?: () => Promise<void> | void
  /** Settles writes already captured by the superseded journal before opening another. */
  beforeJournalOpen?: () => Promise<void> | void
  /** The conversation's own open journal, which the attach adopts: it never opens one itself. */
  openConversation: (record: AgentSessionRecord) => Promise<AgentSessionJournal>
  /** A failure after acquisition released the session's acquisition; `cause` is that failure and
   *  `rootGone` whether the release saw the provider root go. */
  onAcquisitionReleased?: (cause: unknown, verdict: { rootGone: boolean }) => void
  /** The error an acquisition failed with, for a host-side reader of the provider's words; the
   *  refusal never carries them. */
  onAcquisitionFailed?: (error: unknown) => void
}

export async function performAttach(
  input: AttachFlowInput
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const { params, store } = input
  const unsupported = (): AgentSessionMutationResult<AgentSessionAttachResult> => ({
    ok: false,
    refusal: refuse(
      'structured_agent_session_unsupported',
      { reason: 'hostUnsupported' },
      'This execution host cannot create the requested structured agent session.'
    )
  })
  const sessionId = params.envelope.sessionId
  const admitted = admitAttachOrRefuse(params)
  if (!admitted.ok) {
    return admitted
  }
  // Ensure/recovery bypass create-intent, so recheck before reserving or spawning.
  if (!adapterSupportsCreateIfDeclared(input.adapter, params.location, params.agent)) {
    return unsupported()
  }

  let record: AgentSessionRecord
  let acquisitionGeneration: string | null = null
  let acquiredOwner = false
  let providerChildPhase: StructuredAgentSessionProviderChildPhase | null = 'ready'
  let reservedRecord: AgentSessionRecord | null = null
  let unsupportedReservationSettlementAttempted = false
  let replayed = false
  let providerHistoryWindow: ProviderHistoryWindow | null = null
  const preparedTranscript = store.getRecord(sessionId)
    ? { ok: true as const, items: null }
    : await prepareAdoptedTranscript(params)
  if (!preparedTranscript.ok) {
    return preparedTranscript
  }
  try {
    const reserved = await withAgentSessionCreatePhase('reserve_owner', input.recordPhase, () =>
      store.reserveOwner(
        reserveRequestFor({
          sessionId,
          params,
          authority: input.authority,
          callerKey: input.callerKey,
          fingerprint: admitted.fingerprint,
          now: input.now()
        })
      )
    )
    record = reserved.record
    replayed = reserved.disposition === 'replayed'
    // Capability can change while the durable reservation is in flight. Recheck
    // every reservation at its effect boundary so it cannot bypass the support
    // gate, and release a pending reservation that support drift invalidated.
    reservedRecord = record
    if (!adapterSupportsCreateIfDeclared(input.adapter, params.location, params.agent)) {
      if (
        record.lease.claimStatus === 'reserved' &&
        record.lease.handoffStage === 'new-owner-proving' &&
        record.lease.reservedSpawnToken
      ) {
        unsupportedReservationSettlementAttempted = true
        await settleUnsupportedReservation(input, record)
      }
      return unsupported()
    }
    if (
      replayed &&
      reserved.operationRow.outcome.status !== 'pending' &&
      reserved.operationRow.outcome.status !== 'succeeded'
    ) {
      const replay = resolveAgentSessionReplayOutcome({
        operationId: params.envelope.clientOperationId,
        outcome: reserved.operationRow.outcome,
        reconstruct: () => null
      })
      if (replay.decision === 'refuse') {
        return { ok: false, refusal: replay.refusal }
      }
    }
    // Sample provider history before a new child is acquired. Once acquireOwner
    // starts the child, the adapter's liveness signal intentionally becomes
    // conservative and an absent prompt can no longer prove non-delivery.
    providerHistoryWindow = await readProviderHistoryWindow({
      adapter: input.adapter,
      identity: journalIdentityFor(record, params),
      accountHome: record.accountHome,
      ownerAlreadyAdmitted: agentSessionLeaseAdmitsWriter(record.lease)
    })
    if (isReplayedCreateAtRest(input, reserved)) {
      providerChildPhase = null
    } else if (!agentSessionLeaseAdmitsWriter(record.lease)) {
      const acquired = await withAgentSessionCreatePhase('acquire_owner', input.recordPhase, () =>
        acquireOwner(input, record)
      )
      record = acquired.record
      acquisitionGeneration = acquired.acquisitionGeneration
      providerChildPhase = acquired.providerChildPhase
      acquiredOwner = true
    }
  } catch (error) {
    const wording = {
      record: reservedRecord ?? store.getRecord(sessionId),
      newSession: !params.providerHandle
    }
    const spawnToken = reservedRecord?.lease.reservedSpawnToken
    const atRest =
      reservedRecord && spawnToken && !unsupportedReservationSettlementAttempted
        ? await settleFailedStartOfReservation(
            input,
            error,
            { fence: reservedRecord.lease.runtimeFence, spawnToken },
            wording
          )
        : null
    input.onAcquisitionFailed?.(error)
    const failed = atRest ? null : failedAcquisitionRefusal(error, wording)
    const thrown = failed || atRest ? error : preSpawnFailureInWords(error, wording)
    if (failed || atRest || thrown !== error) {
      // The answer carries only its sentence, or none, so what failed is kept here.
      console.warn('[agent-session] provider start failed:', error)
    }
    if (!atRest) {
      return (
        failed ?? {
          ok: false,
          refusal: classifyStoreFailure(
            thrown,
            store.getRecord(sessionId)?.lease.runtimeFence ?? null,
            store.getRecord(sessionId)
          )
        }
      )
    }
    record = atRest
    providerChildPhase = null
  }

  let attached: AttachedJournal
  try {
    await input.beforeJournalOpen?.()
    attached = await attachJournal({
      record,
      params,
      adapter: input.adapter,
      openConversation: input.openConversation,
      providerHistoryWindow
    })
    await importAdoptedTranscript(params, attached, record, preparedTranscript.items)
    await input.onAttached(attached, acquisitionGeneration, acquiredOwner, providerChildPhase)
    if (providerChildPhase !== null) {
      await store.recordOperationOutcome({
        callerKey: input.callerKey,
        operationId: params.envelope.clientOperationId,
        outcome: { status: 'succeeded', sessionId }
      })
    }
  } catch (error) {
    // A chat at rest was settled with its create: nothing ran to settle again.
    if (providerChildPhase === null) {
      throw error
    }
    return settlePostAcquisitionAttachFailure(input, record, error)
  }

  const fence = record.lease.runtimeFence
  const tabId = store.getSessionTabId(sessionId)
  return {
    ok: true,
    replayed,
    fence,
    cursor: attached.journal.cursor(),
    value: {
      sessionId,
      fence,
      page: readAgentSessionHydrationPage(attached.journal, fence),
      unconfirmedClientMessageIds: attached.unconfirmedClientMessageIds,
      ...(tabId ? { tabId } : {})
    }
  }
}

async function readProviderHistoryWindow(input: {
  adapter: StructuredAgentSessionAdapter
  identity: AgentSessionJournalIdentity
  accountHome: AgentSessionRecord['accountHome']
  ownerAlreadyAdmitted: boolean
}): Promise<ProviderHistoryWindow | null> {
  const read = input.adapter.providerHistoryWindow
  if (!read) {
    return null
  }
  let history: ProviderHistoryWindow | null
  try {
    history = await read({ identity: input.identity, accountHome: input.accountHome })
  } catch {
    return null
  }
  // A lease that was already live may belong to a provider child this process
  // has not indexed yet. Preserve the safe unknown outcome in that case.
  return history && input.ownerAlreadyAdmitted ? { ...history, turnInFlight: true } : history
}

async function settleUnsupportedReservation(
  input: AttachFlowInput,
  record: AgentSessionRecord
): Promise<void> {
  const spawnToken = record.lease.reservedSpawnToken
  if (!spawnToken) {
    return
  }
  try {
    await input.store.settleFailedAcquisition({
      sessionId: record.sessionId,
      fence: record.lease.runtimeFence,
      spawnToken,
      callerKey: input.callerKey,
      operationId: input.params.envelope.clientOperationId,
      outcome: {
        status: 'failed',
        code: 'structured_agent_session_unsupported',
        details: { reason: 'hostUnsupported' },
        message: 'Structured session support changed before the provider could start.'
      },
      exitProof: 'processless',
      now: input.now()
    })
  } catch (error) {
    throw new AggregateError([error], 'agent session unsupported reservation settlement failed')
  }
}
