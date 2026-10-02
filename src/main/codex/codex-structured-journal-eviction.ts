import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { CodexHelperName } from './codex-collab-agent-item-translation'
import { endedCodexReasoning, withCodexReasoningLifecycle } from './codex-reasoning-lifecycle'
import type { CodexStructuredItemStreams } from './codex-structured-item-stream-contracts'
import { codexJournalItem, codexStreamingJournalItem } from './codex-structured-item-translation'
import type { CodexActiveJournalItem } from './codex-structured-journal-settlement'

/** The row an active item the bounded live set drops is left with, built like a settle from the
 *  text streamed so far: a started item usually carries none. Null when there is nothing to end. */
export function evictedCodexItemBody(
  active: CodexActiveJournalItem,
  streams: Pick<CodexStructuredItemStreams, 'snapshot'>,
  helperName?: CodexHelperName
): AgentJournalItemBody | null {
  const streamed = streams.snapshot(active.threadId, active.item.id)
  const translated = (
    streamed
      ? codexStreamingJournalItem(active.item, streamed.text)
      : codexJournalItem(active.item, helperName)
  ).body
  return translated ? evictedActiveBody(translated) : null
}

function evictedActiveBody(body: AgentJournalItemBody): AgentJournalItemBody {
  // Evicted, not ended: no end was seen, so none is claimed.
  if (body.kind === 'message') {
    return withCodexReasoningLifecycle(body, endedCodexReasoning())
  }
  if (body.kind === 'tool-call' && body.state === 'running') {
    return { ...body, state: 'failed' }
  }
  if (
    (body.kind === 'approval' || body.kind === 'question') &&
    body.resolution.state === 'pending'
  ) {
    return {
      ...body,
      resolution: {
        state: 'cancelled',
        selectedOptionId: null,
        resolvedBy: null,
        resolvedAt: null
      }
    }
  }
  return body
}
