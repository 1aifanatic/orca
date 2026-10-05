import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { SessionUpdate } from './generated/acp-protocol.generated'

type UserMessageChunk = Extract<SessionUpdate, { sessionUpdate: 'user_message_chunk' }>

/** Saved history replayed into an empty journal (an adopted session). Ids come from the provider
 *  or from the replay's own order, so re-running an interrupted adoption lands the same rows. */
export class AcpHistoryAdoption {
  /** The history turn later frames that name none belong to. */
  turn?: string
  private serial = 0
  private user?: { messageId: string | null; text: string }

  constructor(private readonly thread: string) {}

  turnFor(providerTurn: string | undefined): string {
    return providerTurn ?? this.turn ?? `history:${this.serial++}`
  }

  /** A chunk of the saved user message already buffered. */
  continuesUser(update: UserMessageChunk): boolean {
    return this.user !== undefined && this.user.messageId === (update.messageId ?? null)
  }

  /** Buffers a saved user message: `input.history` takes its whole body once. */
  observeUser(update: UserMessageChunk): void {
    const messageId = update.messageId ?? null
    const previous = this.continuesUser(update) ? (this.user?.text ?? '') : ''
    const text = update.content.type === 'text' ? update.content.text : ''
    this.user = {
      messageId,
      text: boundInlineText(previous + text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
    }
  }

  /** The buffered user message, as the opener of `turn`. */
  takeUser(turn: string): ProviderTimelineEvent[] {
    const user = this.user
    this.user = undefined
    if (!user?.text) {
      return []
    }
    return [
      {
        type: 'input.history',
        item: `history-user:${JSON.stringify([turn, user.messageId])}`,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: user.text }] },
        join: { thread: this.thread, turn }
      }
    ]
  }

  get holdsUser(): boolean {
    return this.user !== undefined
  }
}
