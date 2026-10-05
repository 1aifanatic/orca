import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentRegistry } from './structured-agent-registry'

export function adapterSupportsCreate(
  adapter: StructuredAgentSessionAdapter,
  location: AgentSessionExecutionLocation,
  agent: string
): boolean {
  if (adapter.supportsCreate) {
    return adapter.supportsCreate(location, agent)
  }
  // An adapter with no per-agent gate serves the one agent it was built for, so only its location
  // support can refuse; absence still fails closed here.
  return adapter.supportsLocation?.(location) ?? false
}

/** Honors declared gates while retaining legacy adapters whose acquire path is authoritative. */
export function adapterSupportsCreateIfDeclared(
  adapter: StructuredAgentSessionAdapter,
  location: AgentSessionExecutionLocation,
  agent: string
): boolean {
  if (!adapter.supportsCreate && !adapter.supportsLocation) {
    return true
  }
  return adapterSupportsCreate(adapter, location, agent)
}

export function adapterSupportsRecord(
  adapter: StructuredAgentSessionAdapter,
  record: AgentSessionRecord
): boolean {
  if (adapter.supportsCreate) {
    return adapter.supportsCreate(record.location, record.provider)
  }
  // A record stays readable unless the adapter explicitly rejects its location.
  return adapter.supportsLocation?.(record.location) ?? true
}

/** Whether this build can start the agent of `session`: the agent is registered here, its account
 *  variable is that agent's own (it becomes the child's environment), and every handle it holds is
 *  in the transport the agent's adapter speaks. A record failing this stays readable (tab, history);
 *  only starting its agent is refused, by the one launch admission every agent passes through. */
export function agentDrivesSession(
  agents: Pick<StructuredAgentRegistry, 'definition'>,
  session: Pick<AgentSessionRecord, 'provider' | 'accountHome' | 'providerHandleChain'>
): boolean {
  const definition = agents.definition(session.provider)
  return (
    definition !== null &&
    session.accountHome.variable === definition.accountHomeVariable &&
    session.providerHandleChain.every(
      ({ handle }) =>
        handle.transport === definition.handleTransport && handle.agent === definition.agent
    )
  )
}
