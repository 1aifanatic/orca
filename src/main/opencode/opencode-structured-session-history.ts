import { ProviderTimelineLane } from '../native-chat/agent-session-timeline/provider-timeline-lane'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { OpenCodeHttpError } from './serve/http-response'
import type { OpenCodeSession } from './opencode-structured-session-state'

export async function restoreOpenCodeSessionHistory(
  session: OpenCodeSession,
  sink?: StructuredAgentSessionEventSink
): Promise<void> {
  if (!sink) {
    return
  }
  const { root, translator, client } = session
  if (!root || !translator || !client) {
    throw new Error('OpenCode history requires an owned native session')
  }
  const lane = new ProviderTimelineLane({
    sink,
    signal: session.streamAbort.signal,
    sessionId: session.sessionId,
    agent: session.launch.agent,
    generation: session.generation,
    namespace: root.id
  })
  session.lane = lane
  if (session.launch.resumeSessionId) {
    const history = await client.history(root.id).catch((error: unknown) => {
      if (error instanceof OpenCodeHttpError && error.kind === 'capacity') {
        throw AgentSessionAcquisitionRefusal.historyTooLarge(error.message)
      }
      throw error
    })
    await lane.apply(translator.history(history), true)
  }
}
