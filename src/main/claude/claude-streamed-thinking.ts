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
import {
  createClaudeStreamedTextCheckpoints,
  type ClaudeStreamedBlockEnd
} from './claude-streamed-text-checkpoints'
import {
  claudeRecord,
  claudeText,
  claudeThinkingIdentity,
  claudeThinkingText,
  type ClaudeMessageEnvelope
} from './claude-structured-item-translation'
import type { ClaudeSubagentLinkageSource } from './claude-subagent-linkage'

type ReasoningLifecycle = Pick<AgentJournalMessageItem, 'state' | 'completedAt'>

/** Null for blank thinking: a block with no readable text journals no row. */
export function claudeReasoningBody(
  text: string,
  lifecycle: ReasoningLifecycle
): AgentJournalMessageItem | null {
  return text.trim()
    ? {
        kind: 'message',
        role: 'reasoning',
        blocks: [
          { type: 'text', text: boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text }
        ],
        ...lifecycle
      }
    : null
}

function endedLifecycle(ended: ClaudeStreamedBlockEnd): ReasoningLifecycle {
  return {
    state: 'completed',
    ...(ended.completedAt === undefined ? {} : { completedAt: ended.completedAt })
  }
}

/** The stream a frame belongs to, which a new message in it starts over. */
function streamScope(frame: Record<string, unknown>): string | null {
  const event = claudeRecord(frame.event)
  const sessionId = claudeText(frame.session_id)
  if (frame.type !== 'stream_event' || event?.type !== 'message_start' || !sessionId) {
    return null
  }
  return `${sessionId}/${claudeText(frame.parent_tool_use_id) ?? ''}`
}

export type ClaudeStreamedThinking = ReturnType<typeof createClaudeStreamedThinking>

/** Thinking blocks streamed under --include-partial-messages, written to the same row their
 *  final assistant frame later lands on, and open until that frame or the turn's end. */
export function createClaudeStreamedThinking(deps: {
  sink: StructuredAgentSessionEventSink
  producer: ClaudeSubagentLinkageSource
  turnScope: () => AgentJournalTurnScope
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}) {
  const blocks = createClaudeStreamedBlockRegistry('thinking')
  /** The stream each open block belongs to. */
  const scopes = new Map<string, string>()
  const checkpoints = createClaudeStreamedTextCheckpoints({
    ...(deps.coalesceMs === undefined ? {} : { coalesceMs: deps.coalesceMs }),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    producer: deps.producer,
    persist: (identity, text, options, ended) => {
      const body = claudeReasoningBody(text, ended ? endedLifecycle(ended) : { state: 'running' })
      if (body) {
        deps.sink.appendItem(identity, body, {
          ...options,
          turnScope: deps.turnScope(),
          // An end the sink sheds under pressure would leave the row open with nothing to close it.
          ...(ended ? { lifecycle: true } : {})
        })
        deps.sink.publish()
      }
    }
  })
  const finish = (ended: ClaudeStreamedBlockEnd, scope?: string): void => {
    checkpoints.finish(ended, scope === undefined ? undefined : (key) => scopes.get(key) === scope)
    for (const [key, blockScope] of scopes) {
      if (scope === undefined || blockScope === scope) {
        scopes.delete(key)
      }
    }
  }

  return {
    /** True when the frame carried thinking text. */
    observe: (frame: Record<string, unknown>, observedAt: number): boolean => {
      // A new message in a stream means the previous one's unfinished blocks are never finishing.
      const restarted = streamScope(frame)
      if (restarted !== null) {
        finish({ completedAt: observedAt }, restarted)
      }
      const delta = blocks.observe(frame)
      if (!delta) {
        return false
      }
      const identity = delta.identity
      if (identity.provider === 'claude') {
        scopes.set(
          agentJournalItemKey(identity),
          `${identity.sessionId}/${delta.parentToolUseId ?? ''}`
        )
      }
      checkpoints.append(identity, delta.text, delta.parentToolUseId)
      return true
    },
    /** The row a final frame's thinking lands on — its streamed block's, else its own — closed.
     *  Only a block seen streaming has an observed end. */
    finalize: (
      envelope: ClaudeMessageEnvelope,
      observedAt: number
    ): { identity: AgentJournalItemIdentity; body: AgentJournalMessageItem } | null => {
      if (!envelope.content.some((part) => claudeRecord(part)?.type === 'thinking')) {
        return null
      }
      const streamed = blocks.reconcile(envelope)
      const identity = streamed ?? claudeThinkingIdentity(envelope.sessionId, envelope.uuid)
      const key = agentJournalItemKey(identity)
      // A final frame with no text of its own still ends the row its stream wrote.
      const text = claudeThinkingText(envelope) ?? checkpoints.latest(key) ?? ''
      checkpoints.forget(key)
      scopes.delete(key)
      const body = claudeReasoningBody(
        text,
        endedLifecycle(streamed ? { completedAt: observedAt } : {})
      )
      return body ? { identity, body } : null
    },
    /** End every block still open, for a turn that is ending. */
    finishOpen: (completedAt: number): void => {
      finish({ completedAt })
      blocks.clear()
    },
    flush: checkpoints.flush,
    reattribute: checkpoints.reattribute,
    dispose: (): void => {
      blocks.clear()
      scopes.clear()
      checkpoints.dispose()
    },
    get pending() {
      return checkpoints.pending
    }
  }
}
