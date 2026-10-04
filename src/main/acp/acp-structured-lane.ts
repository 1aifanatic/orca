// One ACP child's path into the journal: the translator turns its traffic into grammar events, and
// the shared assembler writes them. Events apply strictly in order; one the sink refuses under
// backpressure holds every later one until the sink drains, so nothing is reordered or dropped.

import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import {
  createProviderTimelineAssembler,
  type ProviderTimelineAssembler
} from '../native-chat/agent-session-timeline/provider-timeline-assembler'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { spellProviderTimelineKey } from '../native-chat/agent-session-timeline/provider-timeline-identity'
import type { ProviderTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'

/** How long a held event waits for the sink to say it drained before trying again on its own. */
const BACKPRESSURE_RETRY_MS = 250

/** The committed rows in journal order, which the translator reads to recognise replayed work. */
function journalRenderItems(
  journal: StructuredAgentSessionTransitionJournal | null
): AgentJournalRenderItem[] {
  if (!journal) {
    return []
  }
  const order: { itemId: string; sequence: number }[] = []
  journal.visitItems((itemId, sequence) => order.push({ itemId, sequence }))
  order.sort((left, right) => left.sequence - right.sequence)
  return order.flatMap(({ itemId }) => journal.item(itemId) ?? [])
}

export type AcpStructuredLaneDeps = {
  sink: ProviderTimelineSink
  sessionId: string
  agent: string
  generation: string
  providerSessionId: string
  dialect: AcpDialect
  /** A send of Orca's reached the agent: the turn it opened has its first provider event. */
  onInputAccepted: (clientMessageId: string) => void
  /** The sink refused for good; nothing more this child says can be journaled. */
  onFailed: (reason: string) => void
}

export class AcpStructuredLane {
  readonly translator: AcpTimelineTranslator
  private readonly assembler: ProviderTimelineAssembler
  private readonly backlog: ProviderTimelineEvent[] = []
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private failed = false
  private disposed = false

  constructor(private readonly deps: AcpStructuredLaneDeps) {
    this.translator = new AcpTimelineTranslator({
      sessionId: deps.providerSessionId,
      journalItems: () => journalRenderItems(deps.sink.journalItems()),
      dialect: deps.dialect
    })
    this.assembler = createProviderTimelineAssembler({
      sink: deps.sink,
      sessionId: deps.sessionId,
      agent: deps.agent,
      generation: deps.generation,
      namespace: deps.providerSessionId
    })
  }

  get openTurnId(): string | null {
    return this.assembler.openTurnId
  }

  apply(events: readonly ProviderTimelineEvent[]): void {
    if (this.failed || this.disposed) {
      return
    }
    this.backlog.push(...events)
    this.drain()
  }

  /** The sink drained: whatever it held back goes now. */
  retry(): void {
    this.drain()
  }

  /** The legacy-scheme record a request row of `requestKey` is written under, before any
   *  incarnation suffix a reused key adds. */
  requestRecordPrefix(requestKey: string): string {
    return `request:${spellProviderTimelineKey(this.deps.providerSessionId, {
      source: 'provider',
      value: requestKey
    })}`
  }

  /** Whether the journal row `itemId` is the row of request `requestKey`. */
  isRequestRow(itemId: string, requestKey: string): boolean {
    const identity = parseAgentJournalItemKey(itemId)
    if (identity?.provider !== 'legacy' || identity.sessionId !== this.deps.sessionId) {
      return false
    }
    const prefix = this.requestRecordPrefix(requestKey)
    return identity.recordId === prefix || identity.recordId.startsWith(`${prefix}#`)
  }

  flush(): void {
    this.assembler.flush()
  }

  dispose(): void {
    this.disposed = true
    this.clearRetry()
    this.backlog.length = 0
    this.assembler.dispose()
  }

  private drain(): void {
    this.clearRetry()
    while (this.backlog.length > 0 && !this.failed && !this.disposed) {
      const event = this.backlog[0]
      const { admission } = this.assembler.apply(event)
      if (!admission.accepted) {
        if (admission.reason === 'backpressure') {
          this.retryTimer = setTimeout(() => this.drain(), BACKPRESSURE_RETRY_MS)
          return
        }
        this.failed = true
        this.backlog.length = 0
        this.deps.onFailed(admission.reason)
        return
      }
      this.backlog.shift()
      if (event.type === 'input.accepted') {
        this.deps.onInputAccepted(event.clientMessageId)
      }
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }
}
