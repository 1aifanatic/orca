import { transitionHookPresence } from '../shared/agent-hook-presence-transition'
import type { RelayAgentPresence } from './relay-agent-presence'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentHookSource } from '../shared/agent-hook-relay'
import type { RelayHookForward } from './agent-hook-server-options'
import type { AgentHookResultRetryScheduler } from './agent-hook-result-retry-scheduler'
import { cacheRelayLegacyAgentStatus } from '../shared/agent-status-legacy-relay-cache'
import { MAX_CACHED_PANES } from './agent-hook-cached-pane-status'
import { buildRelayHookEnvelope } from './agent-hook-envelope-build'

type RelayEventHost = {
  state: HookListenerState
  observePresence: (event: AgentHookEventPayload) => AgentHookEventPayload
  isPaneSurfaceRetired: (paneKey: string) => boolean
  clearPaneState: (paneKey: string) => void
  retryScheduler: AgentHookResultRetryScheduler
  lastEnvelopeMetaByPaneKey: Map<
    string,
    { source?: AgentHookSource; env?: string; version?: string }
  >
  forward: RelayHookForward
  presenceChecks: RelayAgentPresence
  onAgentEvidence?: (paneKey: string, agent: string) => void
}
export type RelayEventOptions = {
  isReplay?: boolean
  checkPresence?: boolean
  hostPresence?: boolean
}

export function applyRelayAgentEvent(
  host: RelayEventHost,
  incoming: AgentHookEventPayload,
  source: AgentHookSource | undefined,
  env: string | undefined,
  version: string | undefined,
  options: RelayEventOptions
): AgentHookEventPayload | undefined {
  const meta =
    options.hostPresence && !incoming.providerSessionOnly
      ? host.lastEnvelopeMetaByPaneKey.get(incoming.paneKey)
      : undefined
  source ??= meta?.source
  env ??= meta?.env
  version ??= meta?.version
  const transitioned = options.hostPresence
    ? incoming
    : transitionHookPresence(incoming, host.state.lastStatusByPaneKey.get(incoming.paneKey))
  if (!transitioned) {
    return undefined
  }
  const event = host.observePresence(transitioned)
  // Why: this post came from a process still running inside a pane whose tab the user closed.
  // Caching or forwarding it makes every connected client advertise a live, resumable agent pane
  // that no tab owns — the advertisement that ends up auto-typing a second `--resume` onto a
  // transcript the orphan is still writing (#12447). Drop the stale cache with it.
  if (host.isPaneSurfaceRetired(event.paneKey)) {
    host.clearPaneState(event.paneKey)
    return undefined
  }
  if (event.payload.state !== 'done' || event.payload.lastAssistantMessage) {
    host.retryScheduler.clearAssistantMessageRetry(event.paneKey)
  }
  // Why: keep PostCompact identity in the replay cache so the client can re-run ownership when
  // it reconnects. Stripping it would let a cold relay replay a completion as an ordinary `done`
  // row and resurrect a pane that the client had already retired.
  if (
    !cacheRelayLegacyAgentStatus(host.state, event, MAX_CACHED_PANES, (paneKey) =>
      host.clearPaneState(paneKey)
    )
  ) {
    return undefined
  }
  host.lastEnvelopeMetaByPaneKey.delete(event.paneKey)
  host.lastEnvelopeMetaByPaneKey.set(event.paneKey, { source, env, version })
  host.forward(
    buildRelayHookEnvelope(
      options.hostPresence ? { ...event, providerSessionOnly: true } : event,
      source,
      env,
      version,
      { isReplay: options.isReplay }
    )
  )
  const evidenceAgent = event.payload.agentType ?? 'unknown'
  const check = host.presenceChecks.observeHook(
    incoming,
    event,
    !options.hostPresence && options.checkPresence !== false
  )
  if (check) {
    void check.then(() => host.onAgentEvidence?.(event.paneKey, evidenceAgent))
  } else if (!options.hostPresence && options.checkPresence !== false) {
    host.onAgentEvidence?.(event.paneKey, evidenceAgent)
  }
  // Why: retries compare against the cached row by identity, so they must hold that exact row.
  return host.state.lastStatusByPaneKey.get(event.paneKey)
}
