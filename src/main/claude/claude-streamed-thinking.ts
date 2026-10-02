import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { AgentSessionDeltaCoalescerDeps } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeStreamedBlockRegistry } from './claude-streamed-block-identity'
import { createClaudeStreamedTextCheckpoints } from './claude-streamed-text-checkpoints'
import {
  claudeRecord,
  claudeThinkingIdentity,
  type ClaudeMessageEnvelope
} from './claude-structured-item-translation'
import type { ClaudeSubagentLinkageSource } from './claude-subagent-linkage'

/** Null for blank thinking: a block with no readable text journals no row. */
export function claudeReasoningBody(text: string): AgentJournalMessageItem | null {
  return text.trim()
    ? {
        kind: 'message',
        role: 'reasoning',
        blocks: [{ type: 'text', text: boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text }]
      }
    : null
}

export type ClaudeStreamedThinking = ReturnType<typeof createClaudeStreamedThinking>

/** Thinking blocks streamed under --include-partial-messages, written to the
 *  same row their final assistant frame later lands on. */
export function createClaudeStreamedThinking(deps: {
  sink: StructuredAgentSessionEventSink
  producer: ClaudeSubagentLinkageSource
  turnScope: () => AgentJournalTurnScope
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}) {
  const blocks = createClaudeStreamedBlockRegistry('thinking')
  const checkpoints = createClaudeStreamedTextCheckpoints({
    ...(deps.coalesceMs === undefined ? {} : { coalesceMs: deps.coalesceMs }),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    producer: deps.producer,
    persist: (identity, text, options) => {
      const body = claudeReasoningBody(text)
      if (body) {
        deps.sink.appendItem(identity, body, { ...options, turnScope: deps.turnScope() })
        deps.sink.publish()
      }
    }
  })

  return {
    /** True when the frame carried thinking text. */
    observe: (frame: Record<string, unknown>): boolean => {
      const delta = blocks.observe(frame)
      if (delta) {
        checkpoints.append(delta.identity, delta.text, delta.parentToolUseId)
      }
      return delta !== null
    },
    /** The row a final frame's thinking lands on: its streamed block's, else its own. */
    finalIdentity: (envelope: ClaudeMessageEnvelope): AgentJournalItemIdentity | null => {
      if (!envelope.content.some((part) => claudeRecord(part)?.type === 'thinking')) {
        return null
      }
      const identity =
        blocks.reconcile(envelope) ?? claudeThinkingIdentity(envelope.sessionId, envelope.uuid)
      checkpoints.forget(agentJournalItemKey(identity))
      return identity
    },
    flush: checkpoints.flush,
    reattribute: checkpoints.reattribute,
    settle: (): void => {
      blocks.clear()
      checkpoints.settle()
    },
    dispose: (): void => {
      blocks.clear()
      checkpoints.dispose()
    },
    get pending() {
      return checkpoints.pending
    }
  }
}
