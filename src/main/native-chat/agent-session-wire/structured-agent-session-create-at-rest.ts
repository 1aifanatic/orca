// Creating a chat: its record and its journal, at rest. No agent starts here. The chat's first
// message starts one (`structured-agent-session-agent-start`), so a start that fails is reported
// on that message and never fails the create.

import { refuse } from '../../../shared/agent-session-wire-refusals'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import {
  adoptedProviderHandleLink,
  admitAttachOrRefuse,
  classifyStoreFailure,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { adapterSupportsCreateIfDeclared } from './structured-agent-session-provider-support'
import { resolveAgentSessionReplayOutcome } from './structured-agent-session-replay-outcome'
import { readAgentSessionHydrationPage } from './agent-session-history-page'
import { pinnedAgentSessionLaunchArgs } from './structured-agent-session-launch-env'
import {
  importAdoptedTranscript,
  prepareAdoptedTranscript
} from './structured-agent-session-adopted-import'

type CreateResult = AgentSessionMutationResult<AgentSessionAttachResult>

export function createStructuredAgentSessionAtRest(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams
): Promise<CreateResult> {
  return context.serialize(params.envelope.sessionId, () =>
    createAtRest(context, callerKey, params)
  )
}

async function createAtRest(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams
): Promise<CreateResult> {
  const { store, adapter } = context.deps
  const sessionId = params.envelope.sessionId
  if (params.envelope.expectedRuntimeFence !== null) {
    // A create names no fence; one that does is asking to take over an existing chat.
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'requestMalformed' },
        'A create cannot name a runtime fence.'
      )
    }
  }
  const admitted = admitAttachOrRefuse(params)
  if (!admitted.ok) {
    return admitted
  }
  if (!adapterSupportsCreateIfDeclared(adapter, params.location, params.agent)) {
    return {
      ok: false,
      refusal: refuse(
        'structured_agent_session_unsupported',
        { reason: 'hostUnsupported' },
        'This execution host cannot create the requested structured agent session.'
      )
    }
  }
  // Read and checked before the record claims the provider conversation it adopts.
  const transcript = store.getRecord(sessionId)
    ? { ok: true as const, items: null }
    : await prepareAdoptedTranscript(params)
  if (!transcript.ok) {
    return transcript
  }
  let created: Awaited<ReturnType<typeof store.createAtRest>>
  try {
    const now = context.now()
    created = await store.createAtRest({
      sessionId,
      location: params.location,
      provider: params.provider,
      accountHome: params.accountHome,
      ...(params.options ? { options: params.options } : {}),
      ...(params.surfaceTabId ? { surfaceTabId: params.surfaceTabId } : {}),
      ...(await pinnedAgentSessionLaunchArgs(context.deps.resolveLaunchArgs, params)),
      ...(params.adopt
        ? { adoptedHandleLink: adoptedProviderHandleLink(params.adopt.providerHandle, now) }
        : {}),
      claimKeyId: context.deps.claimKeyId,
      operation: {
        callerKey,
        operationId: params.envelope.clientOperationId,
        fingerprint: admitted.fingerprint
      },
      now
    })
  } catch (error) {
    return { ok: false, refusal: classifyStoreFailure(error, null, store.getRecord(sessionId)) }
  }
  if (created.replayed && created.operationRow.outcome.status !== 'succeeded') {
    // A create from before chats were created at rest: it answers only as it ended.
    const replay = resolveAgentSessionReplayOutcome({
      operationId: params.envelope.clientOperationId,
      outcome: created.operationRow.outcome,
      reconstruct: () => null
    })
    if (replay.decision === 'refuse') {
      return { ok: false, refusal: replay.refusal }
    }
  }
  const conversation = await context.openConversation(created.record.sessionId)
  if (!conversation) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_identity_required',
        { reason: 'recordMissing' },
        'No structured session exists by that id.'
      )
    }
  }
  const { journal } = conversation
  if (!created.replayed) {
    await importAdoptedTranscript(
      params,
      { journal, unconfirmedClientMessageIds: [] },
      created.record,
      transcript.items
    )
  }
  const fence = created.record.lease.runtimeFence
  const tabId = store.getSessionTabId(created.record.sessionId)
  return {
    ok: true,
    replayed: created.replayed,
    fence,
    cursor: journal.cursor(),
    value: {
      sessionId: created.record.sessionId,
      fence,
      page: readAgentSessionHydrationPage(journal, fence),
      unconfirmedClientMessageIds: [],
      ...(tabId ? { tabId } : {})
    }
  }
}
