import type {
  ProviderTimelineEvent,
  ProviderTimelineRequestBody
} from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { OpenCodeNativeSession } from './native-protocol'

export type OpenCodePendingRequest = {
  request: string
  nativeId: string
  sessionId: string
  body: ProviderTimelineRequestBody
} & (
  | {
      kind: 'permission'
      permission: string
      patterns: string[]
      always: string[]
      native: Record<string, unknown>
    }
  | { kind: 'question'; questions: unknown[]; native: Record<string, unknown> }
  | { kind: 'form'; form: Record<string, unknown>; native: Record<string, unknown> }
)

export type OpenCodeTimelineTranslation = {
  events: ProviderTimelineEvent[]
  requests?: OpenCodePendingRequest[]
  withdrawnRequestIds?: string[]
  children?: OpenCodeNativeSession[]
  rootIdle?: boolean
  acceptedNativeMessageIds?: string[]
}
