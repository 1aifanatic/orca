import { normalizeHookPayload } from '../shared/agent-hook-listener'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import { isAgentHookSource, type AgentHookSource } from '../shared/agent-hook-relay'
import { buildSpoolHookBody, type SpoolRecord } from '../shared/agent-hook-spool'
import { hookBodyEnv, hookBodyVersion } from './agent-hook-envelope-build'

export function ingestRelayHookSpoolRecord(
  record: SpoolRecord,
  state: HookListenerState,
  env: string,
  host: {
    apply: (
      event: AgentHookEventPayload,
      source: AgentHookSource,
      env?: string,
      version?: string
    ) => void
    isPaneSurfaceRetired: (paneKey: string) => boolean
  }
): void {
  if (!isAgentHookSource(record.source)) {
    return
  }
  const body = buildSpoolHookBody(record)
  const event = normalizeHookPayload(state, record.source, body, env, {
    admitOpenCodeTui: ({ paneKey }) => !host.isPaneSurfaceRetired(paneKey),
    deferCompactOwnershipToClient: true
  })
  if (event) {
    host.apply(event, record.source, hookBodyEnv(body), hookBodyVersion(body))
  }
}
