import type { AgentModelCatalogProbe } from './agent-model-catalog-store'

/**
 * What every agent registration must say about its models: a probe that lists them without
 * starting a session, or that it has none. Refresh, keying, persistence and publication are the
 * catalog service's, never the agent's. An agent with no probe shows the provider-default
 * placeholder until a live session reports.
 */
export type AgentModelCatalogDiscovery =
  | { kind: 'probe'; probe: AgentModelCatalogProbe }
  | { kind: 'unavailable'; reason: string }
