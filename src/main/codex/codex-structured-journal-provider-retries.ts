// The one row a run of Codex stream retries writes: Codex's own progress sentence and a
// `providerRetrying` fact, revised in place by every attempt of the run.
//
// Codex numbers an attempt only inside its sentence ("Reconnecting... 2/5", or none at all while
// it waits for the network), so a run is the retry frames of one turn with nothing else the
// thread journals between them. A later run is a new row, below whatever the thread did meanwhile.

import {
  agentSessionFailureFact,
  providerDiagnostic,
  readProviderRetry
} from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { AgentJournalStatusItem } from '../../shared/agent-session-journal-types'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/tui-agent-display-names'
import {
  boundPayload,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import { classifyProviderFrame } from '../native-chat/agent-session-wire/provider-frame-disposition'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-contracts'
import { appendCodexItemAndPublish } from './codex-structured-journal-sink'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import {
  readCodexErrorInfo,
  readCodexErrorMessage,
  readCodexErrorWillRetry,
  readCodexTurnId
} from './codex-structured-thread-facts'
import type { CodexRowLinkage } from './codex-subagent-linkage'

/** An `error` frame for a stream error Codex is about to retry; it ends nothing. */
export function isCodexProviderRetryFrame(event: CodexStructuredSessionEvent): boolean {
  return (
    event.type === 'notification' &&
    event.method === 'error' &&
    readCodexErrorWillRetry(event.params)
  )
}

export function codexProviderRetryRowBody(payload: unknown): AgentJournalStatusItem {
  const message = readCodexErrorMessage(payload)
  const detail = message ? providerDiagnostic(message, 'person') : undefined
  const retry = readProviderRetry(readCodexErrorInfo(payload))
  const words = agentSessionFailureWords(
    agentSessionFailureFact('providerRetrying', {
      ...(detail ? { detail } : {}),
      ...(retry ? { retry } : {})
    }),
    { surface: 'row', agentName: TUI_AGENT_DISPLAY_NAMES.codex }
  )
  return {
    kind: 'status',
    tone: 'warning',
    ...words,
    // Codex's `additionalDetails` is diagnostic, so it stays behind the row's details, not in it.
    providerFrame: {
      provider: 'codex',
      kind: 'notification:error',
      payload: boundPayload(JSON.stringify(payload), DEFAULT_JOURNAL_PAYLOAD_LIMITS)
    }
  }
}

/** Whether a frame can put a row in its thread's timeline. Chrome, such as the thread status
 *  Codex reports beside each retry, journals nothing; a turn boundary always does. */
function codexFrameMayJournal(event: CodexStructuredSessionEvent): boolean {
  if (event.type !== 'notification') {
    return true
  }
  if (event.method === 'turn/started' || event.method === 'turn/completed') {
    return true
  }
  const classification = classifyProviderFrame(
    'codex',
    `notification:${event.method}`,
    event.params
  )
  return classification !== 'status-chrome' && classification !== 'suppressed-benign'
}

export class CodexJournalProviderRetries {
  /** The open run per thread: one at most, since a thread runs one turn at a time. */
  private readonly openRuns = new Map<string, { turnId: string; run: number }>()
  private runs = 0

  constructor(
    private readonly deps: { sink: StructuredAgentSessionEventSink; linkageFor: CodexRowLinkage },
    private readonly activeTurn: (threadId: string) => string | null
  ) {}

  /** Writes or revises the run's row. Every attempt publishes: that is the activity the idle
   *  sweep reads while Codex keeps retrying. */
  append(threadId: string, payload: unknown): CodexJournalTranslationAdmission {
    const frameTurnId = readCodexTurnId(payload) ?? this.activeTurn(threadId)
    const turnId = frameTurnId ?? 'outside-turn'
    let open = this.openRuns.get(threadId)
    if (open?.turnId !== turnId) {
      // Opened before the write, so a frame re-handled after backpressure revises the same row.
      open = { turnId, run: (this.runs += 1) }
      this.openRuns.set(threadId, open)
    }
    return appendCodexItemAndPublish(
      this.deps.sink,
      {
        provider: 'orca',
        clientMessageId: `provider-retry:codex:${threadId}:${turnId}:${open.run}`
      },
      codexProviderRetryRowBody(payload),
      this.deps.linkageFor(threadId, frameTurnId)
    )
  }

  /** Called for every frame but a retry: one that can journal a row ends its thread's run. */
  observe(event: CodexStructuredSessionEvent): void {
    if (event.type !== 'ended' && codexFrameMayJournal(event)) {
      this.openRuns.delete(event.threadId)
    }
  }

  clear(): void {
    this.openRuns.clear()
  }
}
