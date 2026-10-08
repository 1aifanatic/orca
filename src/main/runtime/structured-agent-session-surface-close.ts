import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionCloseCause } from '../native-chat/agent-session-wire/structured-agent-session-host-lifetime'
import type { OrcaRuntimeService } from './orca-runtime'

export async function closeStructuredAgentSessionSurface(
  runtime: Pick<OrcaRuntimeService, 'retireStructuredAgentSessionTabFromSnapshot'>,
  host: StructuredAgentSessionHost | null,
  sessionId: string,
  cause: StructuredAgentSessionCloseCause
): Promise<void> {
  if (typeof host?.setSessionTabVisibility === 'function') {
    // Restore bookkeeping must not prevent the user's close.
    await host.setSessionTabVisibility(sessionId, false).catch((error: unknown) => {
      host.deps.logger.warn('recording a closed chat tab failed', {
        scope: 'tab-visibility-close',
        sessionId,
        error
      })
    })
  }
  runtime.retireStructuredAgentSessionTabFromSnapshot(sessionId)
  if (typeof host?.close === 'function') {
    await host.close(sessionId, cause)
  }
}
