import { openCodeSessionSchema, type OpenCodeWireEvent } from './native-protocol'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { OpenCodeTimelineTranslation } from './timeline-contract'
import { OpenCodeTimelineState } from './timeline-state'
import { string, valueAt } from './timeline-shapes'
import { translateV1 } from './timeline-v1'
import { translateV2 } from './timeline-v2'
import { translateHistory } from './timeline-history'
import { OpenCodeHttpError } from './http-response'

export type { OpenCodePendingRequest, OpenCodeTimelineTranslation } from './timeline-contract'

/** Converts one owned OpenCode server stream into the journal's provider grammar. */
export class OpenCodeTimelineTranslator extends OpenCodeTimelineState {
  translate(event: OpenCodeWireEvent, at = Date.now()): OpenCodeTimelineTranslation {
    const data = event.data
    const announced =
      event.type === 'session.created' || event.type === 'session.updated'
        ? openCodeSessionSchema.safeParse(
            this.options.major === 1 ? data.info : { ...data, id: data.sessionID }
          )
        : undefined
    if (announced && !announced.success) {
      throw new OpenCodeHttpError('invalid-response', 'OpenCode sent an unreadable session event')
    }
    if (announced?.success) {
      const session = announced.data
      if (session.parentID && this.ownsSession(session.parentID)) {
        const known = this.ownsSession(session.id)
        this.registerSession(session)
        return { events: [], ...(known ? {} : { children: [session] }) }
      }
      if (session.id === this.options.sessionId) {
        this.registerSession(session)
      }
      return { events: [] }
    }
    const sessionId =
      string(data.sessionID) ??
      string(valueAt(data, 'part', 'sessionID')) ??
      string(valueAt(data, 'form', 'sessionID')) ??
      string(valueAt(data, 'info', 'sessionID')) ??
      (event.type === 'session.error' ? this.options.sessionId : undefined)
    if (!sessionId || !this.ownsSession(sessionId)) {
      return { events: [] }
    }
    return this.options.major === 1
      ? translateV1(this, event, sessionId, at)
      : translateV2(this, event, sessionId, at)
  }

  history(messages: unknown): ProviderTimelineEvent[] {
    return translateHistory(this, messages)
  }
}
