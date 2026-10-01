import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import type { AgentType } from './agent-status-types'
import { isRetainedSessionRemnant } from './agent-hook-presence-transition'
import { normalizedKnownAgentType } from './agent-status-identity'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type AgentResumeIdentity
} from './agent-session-resume'

/** Only the saved hook route can establish a legacy session's provider. */
export function decodeHookResumeSession(
  raw: unknown,
  source: unknown,
  connectionId: string | null
): AgentProviderSessionMetadata | undefined {
  const session = normalizeAgentProviderSession(raw)
  if (!session || session.resumeIdentity) {
    return session ?? undefined
  }
  // Older remote OMP rows synthesized source from display identity, not the hook route.
  if (!isResumableTuiAgent(source) || (source === 'omp' && connectionId !== null)) {
    return session
  }
  return { ...session, resumeIdentity: { agent: source } }
}

/** Status inheritance must take the owner's whole resume record, never the child's locator. */
export function inheritAgentResumeIdentity(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined,
  agent: AgentType | undefined
): AgentHookEventPayload {
  // Why: only a live previous row of the displayed agent owns the pane, and only a nested event
  // (another named agent, or a subagent) defers to it; otherwise the event's own session stands.
  const nested =
    Boolean(incoming.toolAgentId) ||
    (normalizedKnownAgentType(incoming.payload.agentType) !== null &&
      agent !== incoming.payload.agentType)
  const borrowed =
    agent !== undefined &&
    previous?.payload.agentType === agent &&
    !isRetainedSessionRemnant(previous) &&
    nested
      ? previous
      : undefined
  const own = decodeHookResumeSession(
    incoming.providerSession,
    incoming.source,
    incoming.connectionId
  )
  const inherited = borrowed
    ? decodeHookResumeSession(borrowed.providerSession, borrowed.source, borrowed.connectionId)
    : undefined
  let providerSession = own
  if (borrowed && inherited) {
    // Why: the row keeps the child's source, so a borrowed legacy session must name its owner now.
    providerSession =
      !inherited.resumeIdentity && isResumableTuiAgent(agent)
        ? { ...inherited, resumeIdentity: { agent } }
        : inherited
  } else if (borrowed) {
    // Why: an owner row with no session yet (withheld after a finished turn) keeps the event's own
    // session only when that session is the displayed agent's.
    providerSession = own?.resumeIdentity?.agent === agent ? own : undefined
  }
  return {
    ...incoming,
    providerSession,
    payload: { ...incoming.payload, agentType: agent }
  }
}

/** The hook route owns the session; older unlabelled records retain their display agent. */
export function resolveResumeAgent<T extends string>(
  displayAgent: T,
  session: AgentProviderSessionMetadata
): T | AgentResumeIdentity['agent'] {
  return session.resumeIdentity?.agent ?? displayAgent
}

/** Strict older RPC decoders accept only the locator, alongside the resolved agent. */
export function providerSessionForResumeRequest(
  session: AgentProviderSessionMetadata
): AgentProviderSessionMetadata {
  return {
    key: session.key,
    id: session.id,
    ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {})
  }
}

export function agentResumeIdentitiesEqual(
  left: AgentResumeIdentity | undefined,
  right: AgentResumeIdentity | undefined
): boolean {
  return left?.agent === right?.agent
}
