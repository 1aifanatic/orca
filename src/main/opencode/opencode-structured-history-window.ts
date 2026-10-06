import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { OPENCODE_TRANSCRIPT_MAX_WINDOW } from '../../shared/opencode-transcript-page-limit'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { ProviderHistoryWindow } from '../native-chat/agent-session-journal/journal-submission-reconciler'
import type { OpenCodeStructuredSessionAdapterDeps } from './opencode-structured-session-state'
import { resolveOpenCodeDatabasePath } from './opencode-data-directory'
import { openCodeUserIdentity } from './opencode-structured-session-identity'

export async function readOpenCodeProviderHistoryWindow(
  identity: AgentSessionJournalIdentity,
  deps: OpenCodeStructuredSessionAdapterDeps
): Promise<ProviderHistoryWindow | null> {
  const signal = AbortSignal.timeout(5_000)
  try {
    const launch = await waitForPromiseWithSignal(deps.resolveLaunch({ identity }), signal)
    if (!launch.resumeSessionId || launch.agent !== identity.agent) {
      return null
    }
    const dbPath = resolveOpenCodeDatabasePath(launch.environment)
    if (!dbPath) {
      return null
    }
    const read =
      deps.readHistoryPage ??
      (
        await waitForPromiseWithSignal(
          import('../ai-vault/session-scanner-opencode-sqlite-worker-spawn'),
          signal
        )
      ).readOpenCodeTranscriptPageViaWorker
    const page = await waitForPromiseWithSignal(
      read(
        { dbPath, sessionId: launch.resumeSessionId, limit: OPENCODE_TRANSCRIPT_MAX_WINDOW },
        signal
      ),
      signal
    )
    if (!page) {
      return null
    }
    return {
      boundaryConsistent: false,
      turnInFlight: true,
      items: page.items.flatMap(({ message }) => {
        if (message.role !== 'user') {
          return []
        }
        const nativeMessageId = message.id.replace(/^opencode:/, '')
        if (!/^msg_[a-zA-Z0-9]+$/.test(nativeMessageId) || nativeMessageId.length > 512) {
          return []
        }
        return [
          {
            providerItemId: nativeMessageId,
            clientMessageId: null,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.send',
              sessionId: identity.sessionId,
              fields: { body: { kind: 'message', role: 'user', blocks: message.blocks } }
            }),
            identity: openCodeUserIdentity({
              agent: launch.agent,
              sessionId: identity.sessionId,
              nativeSessionId: launch.resumeSessionId!,
              nativeMessageId
            })
          }
        ]
      })
    }
  } catch (error) {
    deps.logger?.warn('OpenCode recovery history could not be read', {
      scope: 'opencode-recovery-history',
      sessionId: identity.sessionId,
      error
    })
    return null
  }
}
