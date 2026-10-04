import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { BoundedMap } from '../../shared/bounded-map'
import { backgroundTaskJournalBody } from '../../shared/native-chat-background-task-row'
import {
  isBackgroundTaskBlock,
  type NativeChatBackgroundTaskBlock
} from '../../shared/native-chat-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type {
  ProviderTimelineEvent,
  ProviderTimelineJoin
} from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpBackgroundTaskUpdate } from './acp-dialects/acp-dialect'

/** Partial provider snapshots only; the assembler owns settlement and durable placement. */
export class AcpBackgroundTaskTimeline {
  private readonly snapshots = new BoundedMap<string, NativeChatBackgroundTaskBlock>({
    maxEntries: 128,
    maxBytes: 1024 * 1024,
    sizeOf: (block, key) => Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(block))
  })

  constructor(private readonly journalItems: () => readonly AgentJournalRenderItem[]) {}

  translate(
    updates: AcpBackgroundTaskUpdate[],
    join: ProviderTimelineJoin
  ): ProviderTimelineEvent[] {
    return updates.map((update) => {
      const previous = this.snapshots.get(update.taskId) ?? this.persisted(update.taskId)
      const block: NativeChatBackgroundTaskBlock = {
        type: 'background-task',
        kind: 'unknown',
        label: update.taskId,
        ...previous,
        ...update
      }
      for (const key of ['label', 'summary', 'error', 'outputFile'] as const) {
        const text = block[key]
        if (text !== undefined) {
          block[key] = boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
        }
      }
      this.snapshots.set(block.taskId, block)
      return {
        type: 'item.update',
        item: `background-task:${block.taskId}`,
        body: backgroundTaskJournalBody(block),
        join
      }
    })
  }

  private persisted(taskId: string): NativeChatBackgroundTaskBlock | undefined {
    for (const row of this.journalItems()) {
      if (row.body.kind !== 'message') {
        continue
      }
      const block = row.body.blocks.find(
        (candidate) => isBackgroundTaskBlock(candidate) && candidate.taskId === taskId
      )
      if (block && isBackgroundTaskBlock(block)) {
        return block
      }
    }
    return undefined
  }
}
