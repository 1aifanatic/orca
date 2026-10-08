// A `/compact` Orca sends as a prompt, run as the command turn the host opened. What the agent
// writes meanwhile is the command's output, read for how it went and never drawn; its answer ends
// the turn with one result row, as Claude's and Codex's compactions end.

import { providerDiagnostic } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { structuredCompactionOutcome } from '../native-chat/agent-session-wire/structured-conversation-command-outcome'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import type { ContentBlock, SessionUpdate } from './generated/acp-protocol.generated'

/** The prompt every compacting ACP agent takes as its own compaction command. */
export const ACP_COMPACT_PROMPT: readonly ContentBlock[] = [{ type: 'text', text: '/compact' }]

/** What a running compaction has said so far. */
export type AcpCompaction = { reply: string; failureDetail?: string }

/** Reads the running compaction's reply text; true for an update that is its output. */
export function readAcpCompactionUpdate(compaction: AcpCompaction, update: SessionUpdate): boolean {
  if (update.sessionUpdate === 'agent_message_chunk') {
    if (update.content.type === 'text') {
      compaction.reply += update.content.text
    }
    return true
  }
  return update.sessionUpdate === 'agent_thought_chunk'
}

/** The compaction's result row and its turn's end, from the agent's answer. */
export function acpCompactionEnd(input: {
  compaction: AcpCompaction
  turn: string
  thread: string
  stopReason: string
  at: number
  durationMs?: number
  /** Words the answer itself carried, for one that failed. */
  failureDetail?: string
  dialect: AcpDialect
  agentName?: string
}): ProviderTimelineEvent[] {
  const { compaction, turn, stopReason } = input
  // The host's command turn is the assembler's open turn, which no provider key names.
  const join = { thread: input.thread }
  const end = (outcome: 'success' | 'failure' | 'cancellation'): ProviderTimelineEvent => ({
    type: 'turn.end',
    at: input.at,
    state: outcome === 'cancellation' ? 'interrupted' : 'completed',
    outcome,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs })
  })
  const reply =
    stopReason === 'end_turn' ? input.dialect.compactionReply?.(compaction.reply) : undefined
  if (reply?.outcome === 'skipped') {
    // Nothing to compact is no failure: the turn succeeds and says why nothing changed.
    const text = providerDiagnostic(reply.detail, 'person')?.text ?? 'Nothing to compact'
    return [
      {
        type: 'item.close',
        item: `compaction:${turn}`,
        body: { kind: 'status', tone: 'warning', text },
        join
      },
      end('success')
    ]
  }
  const words = reply?.detail ?? input.failureDetail ?? compaction.failureDetail
  const detail = words === undefined ? undefined : providerDiagnostic(words, 'person')
  const verdict = structuredCompactionOutcome({
    // An agent that ends `/compact` normally compacted, unless its reply says otherwise.
    compacted: stopReason === 'end_turn' && reply === undefined,
    interruptRequested: stopReason === 'cancelled',
    failed: detail ? { detail } : {}
  })
  if (verdict.outcome === 'cancellation') {
    return [end('cancellation')]
  }
  const body =
    verdict.outcome === 'success' || !verdict.failure
      ? { kind: 'status' as const, text: 'Context compacted', presentation: 'compaction' as const }
      : {
          kind: 'status' as const,
          ...agentSessionFailureWords(verdict.failure, {
            surface: 'row',
            ...(input.agentName === undefined ? {} : { agentName: input.agentName })
          }),
          tone: 'error' as const
        }
  return [{ type: 'item.close', item: `compaction:${turn}`, body, join }, end(verdict.outcome)]
}
