import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import type { AgentType } from './agent-status-types'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type AgentResumeIdentity
} from './agent-session-resume'

export const AGENT_RESUME_IDENTITY_ERROR =
  'Cannot resume this session because its agent ownership could not be verified. The saved session is preserved. You can start a fresh agent separately.'

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
  // Why: only a previous row of the displayed agent is an owner; otherwise the event's own session stands.
  const owner =
    agent !== undefined &&
    previous?.payload.agentType === agent &&
    (agent !== incoming.payload.agentType || incoming.toolAgentId)
      ? previous
      : incoming
  return {
    ...incoming,
    providerSession: decodeHookResumeSession(
      owner.providerSession,
      owner.source,
      owner.connectionId
    ),
    payload: { ...incoming.payload, agentType: agent }
  }
}

/** One resume rule: no identity is a record saved before ownership existed and resumes as before;
 *  only an identity naming another agent refuses. */
export function agentResumeIdentityPermits(
  agent: string,
  session: AgentProviderSessionMetadata
): boolean {
  return session.resumeIdentity === undefined || session.resumeIdentity.agent === agent
}

/** Strict older RPC decoders accept only the locator; validate ownership before projecting it. */
export function providerSessionForResumeRequest(
  agent: string,
  session: AgentProviderSessionMetadata
): AgentProviderSessionMetadata {
  if (!agentResumeIdentityPermits(agent, session)) {
    throw new Error(AGENT_RESUME_IDENTITY_ERROR)
  }
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
