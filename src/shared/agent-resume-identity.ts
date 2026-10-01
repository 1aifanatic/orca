import { launchConfigsEqual } from './sleeping-agent-launch-config'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent,
  type SleepingAgentLaunchConfig
} from './agent-session-resume'
import { sleepingAgentLaunchConfigSchema } from './agent-resume-launch-config-schema'

export type AgentResumeIdentity = {
  agent: ResumableTuiAgent
  connectionId: string | null
  launchConfig?: SleepingAgentLaunchConfig
}

export const AGENT_RESUME_IDENTITY_ERROR =
  'Cannot resume this session because its agent ownership could not be verified. The saved session is preserved. You can start a fresh agent separately.'

export function readAgentResumeIdentity(raw: unknown): AgentResumeIdentity | null {
  if (!raw || typeof raw !== 'object' || !('agent' in raw) || !('connectionId' in raw)) {
    return null
  }
  if (
    !isResumableTuiAgent(raw.agent) ||
    (raw.connectionId !== null &&
      (typeof raw.connectionId !== 'string' || !raw.connectionId.trim()))
  ) {
    return null
  }
  const config = 'launchConfig' in raw ? raw.launchConfig : undefined
  const parsed = sleepingAgentLaunchConfigSchema.safeParse(config)
  if (!parsed.success || (config !== undefined && parsed.data === undefined)) {
    return null
  }
  return {
    agent: raw.agent,
    connectionId: raw.connectionId,
    ...(parsed.data ? { launchConfig: parsed.data } : {})
  }
}

/** Only the saved hook route can establish a legacy session's provider. */
export function decodeHookResumeSession(
  raw: unknown,
  source: unknown,
  connectionId: string | null
): AgentProviderSessionMetadata | undefined {
  const session = normalizeAgentProviderSession(raw)
  if (!session || session.resumeIdentity !== undefined) {
    return session ?? undefined
  }
  // Older remote OMP rows synthesized source from display identity, not the hook route.
  if (!isResumableTuiAgent(source) || (source === 'omp' && connectionId !== null)) {
    return session
  }
  return { ...session, resumeIdentity: { agent: source, connectionId } }
}

/** Status inheritance must take the owner's whole resume record, never the child's locator. */
export function inheritAgentResumeIdentity(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined,
  agent: string
): AgentHookEventPayload {
  const owner = agent !== incoming.payload.agentType || incoming.toolAgentId ? previous : incoming
  const decoded = owner
    ? decodeHookResumeSession(owner.providerSession, owner.source, owner.connectionId)
    : undefined
  const providerSession =
    decoded?.resumeIdentity?.connectionId === null && owner === incoming
      ? {
          ...decoded,
          resumeIdentity: { ...decoded.resumeIdentity, connectionId: owner.connectionId }
        }
      : decoded
  return {
    ...incoming,
    providerSession,
    payload: { ...incoming.payload, agentType: agent }
  }
}

export function isOwnedAgentResumeSession(
  agent: string,
  session: AgentProviderSessionMetadata,
  connectionId?: string | null
): boolean {
  const identity = session.resumeIdentity
  return Boolean(
    identity &&
    identity.agent === agent &&
    (connectionId === undefined || identity.connectionId === connectionId)
  )
}

/** The launch writer attaches only settings already matched to this provider and launch. */
export function captureAgentResumeLaunchConfig(
  session: AgentProviderSessionMetadata,
  agent: string,
  config: SleepingAgentLaunchConfig | undefined
): AgentProviderSessionMetadata {
  const identity = session.resumeIdentity
  if (!identity || identity.agent !== agent || identity.launchConfig || !config) {
    return session
  }
  return {
    ...session,
    resumeIdentity: {
      ...identity,
      launchConfig: { ...config, agentEnv: { ...config.agentEnv } }
    }
  }
}

/** Strict older RPC decoders accept only the locator; validate ownership before projecting it. */
export function providerSessionForResumeRequest(
  agent: string,
  session: AgentProviderSessionMetadata
): AgentProviderSessionMetadata {
  if (session.resumeIdentity !== undefined && !isOwnedAgentResumeSession(agent, session)) {
    throw new Error(AGENT_RESUME_IDENTITY_ERROR)
  }
  return {
    key: session.key,
    id: session.id,
    ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {})
  }
}

export function agentResumeIdentitiesEqual(
  left: AgentResumeIdentity | null | undefined,
  right: AgentResumeIdentity | null | undefined
): boolean {
  if (!left || !right) {
    return left === right
  }
  return (
    left.agent === right.agent &&
    left.connectionId === right.connectionId &&
    launchConfigsEqual(left.launchConfig, right.launchConfig)
  )
}
