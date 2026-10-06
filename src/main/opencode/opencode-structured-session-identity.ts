import type { AgentType } from '../../shared/agent-session-journal-types'
import { createLegacyProviderTimelineIdentityScheme } from '../native-chat/agent-session-timeline/provider-timeline-identity'

export function openCodeUserIdentity(input: {
  agent: AgentType
  sessionId: string
  nativeSessionId: string
  nativeMessageId: string
}) {
  return createLegacyProviderTimelineIdentityScheme(input).item({
    namespace: input.nativeSessionId,
    key: { source: 'provider', value: input.nativeMessageId },
    family: 'item',
    thread: null
  })
}
