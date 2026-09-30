// Where a structured chat session's background errors go: failures a catch site swallows or
// settles itself, so no caller ever sees them. Every such site reports here with its own step, so
// none depends on a caller having wired a sink: the trace file is installed once at startup, and
// the diagnostic bundle ships it. The console line is the only record where no trace sink is
// installed (dev runs, orcad, diagnostics disabled); a packaged desktop main process owns no console.

import { startSpan } from './tracer'

/**
 * Every step, and what its trace record and console line may carry: `full` records the error's
 * stack and cause chain; `kind` records only its class and code. The trace redactor strips
 * credentials, not prose or paths, so a step whose error can quote user content must be `kind`.
 * The recovery capsule steps are, because a corrupt capsule fails `JSON.parse` in
 * agent-session-recovery-capsule-entries.ts, and a SyntaxError message quotes the capsule's text.
 * The operation-settlement and restart-continuation steps are because the restart privacy tests
 * pin that their errors never reach a log.
 */
export const AGENT_SESSION_ERROR_STEPS = {
  // Provider lifecycle delivered to the host.
  'provider-started-settlement': 'full',
  'provider-exit-settlement': 'full',
  'provider-exit-barrier': 'full',
  'provider-exit-lease-release': 'full',
  'provider-start': 'full',
  'started-options-persist': 'full',
  'late-dispatch-settlement': 'full',
  'unanswered-dispatch-release': 'full',
  'dead-generation-settlement': 'full',
  'sink-failure-recovery': 'full',
  'operation-agent-start': 'full',
  // Chat creation, before and after it commits.
  'create-precommit': 'full',
  'create-tab-publish': 'full',
  // Claude's side of a session.
  'claude-attachment-read': 'full',
  'claude-dispatch-write': 'full',
  'claude-history-window': 'full',
  'claude-option-restore': 'full',
  'claude-resume-point-persist': 'full',
  'claude-exit-cursor-persist': 'full',
  // The journal and what writes through it.
  'event-sink': 'full',
  'journal-delivery': 'full',
  'journal-database-open': 'full',
  'journal-open-read': 'full',
  'journal-open-write': 'full',
  'journal-open-pending-doubt': 'full',
  'journal-rollback': 'full',
  'journal-row-bookkeeping': 'full',
  'legacy-journal-import': 'full',
  'legacy-journal-retire': 'full',
  'gone-generation-settlement': 'full',
  'death-evidence-resettle': 'full',
  'restart-reconciliation': 'full',
  'dispatch-doubt-record': 'full',
  // Leases.
  'lease-probe': 'full',
  'lease-renewal': 'full',
  // Delivery, queued drafts and Stop.
  'delivery-wake': 'full',
  'delivery-loop': 'full',
  'delivery-loop-failure-settlement': 'full',
  'idle-sweep': 'full',
  'queued-drain': 'full',
  'queued-send-failure-hold': 'full',
  'queued-owed-settlement': 'full',
  'queued-repair': 'full',
  'queued-abandon': 'full',
  'queue-pause-retire': 'full',
  'clear-draft-carry': 'full',
  'stop-owed-settlement': 'full',
  'stop-queue-pause': 'full',
  'operation-uncertainty-persist': 'kind',
  'refused-operation-settlement': 'kind',
  'rewind-recovery': 'full',
  // Status projection.
  'status-publish': 'full',
  'status-forget': 'full',
  'status-observer': 'full',
  'child-work-publish': 'full',
  // Restart recovery.
  'recovery-capsule-read': 'kind',
  'recovery-capsule-record': 'kind',
  'recovery-witness-begin': 'kind',
  'recovery-witness-capture': 'kind',
  'recovery-records-forget': 'kind',
  'restart-offer-prune': 'kind',
  'restart-offer-withdraw': 'kind',
  'restart-offer-complete': 'kind',
  'restart-offer-rollback': 'kind',
  'restart-offer-refresh': 'kind',
  'restart-failure-record': 'kind',
  'restart-continuation-send': 'kind',
  'restart-continuation-note': 'kind',
  // Chat tabs.
  'tab-visibility-restore': 'full',
  'worker-tab-retire': 'full'
} as const satisfies Record<string, 'full' | 'kind'>

/** Closed so trace readers can rely on the vocabulary; add a step above with its catch site. */
export type AgentSessionErrorStep = keyof typeof AGENT_SESSION_ERROR_STEPS

export type AgentSessionErrorReport = {
  step: AgentSessionErrorStep
  sessionId?: string
  error: unknown
  /** Ids and closed-vocabulary facts only; attributes pass through the trace redactor. */
  detail?: Record<string, string | number | boolean>
}

const SPAN_NAME = 'agent-session.failure'
const MAX_CAUSE_DEPTH = 5
const MAX_AGGREGATE_ERRORS = 10

/** Never throws: reporting is bookkeeping and must not replace the failure it describes. */
export function traceAgentSessionError(report: AgentSessionErrorReport): void {
  const { step, sessionId, error, detail } = report
  const kindOnly = AGENT_SESSION_ERROR_STEPS[step] === 'kind'
  // The report's own step and session win over a same-named detail key.
  const context = { ...detail, ...(sessionId === undefined ? {} : { sessionId }) }
  try {
    startSpan(SPAN_NAME, { attributes: { ...context, step } }).fail(
      kindOnly ? errorKind(error) : describeFailure(error)
    )
  } catch {
    // The console line below still carries it.
  }
  try {
    console.warn(`[agent-session] ${step} failed`, context, kindOnly ? errorKind(error) : error)
  } catch {
    // Nothing left to tell.
  }
}

/** The whole chain: a wrapper's message alone names the step and nothing else. */
function describeFailure(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  const code = errorCode(error)
  // `code` (SQLITE_*, journal_*) is often the only part the message leaves out.
  const head = `${error.stack ?? `${error.name}: ${error.message}`}${code === undefined ? '' : `\n[code] ${code}`}`
  if (depth >= MAX_CAUSE_DEPTH) {
    return head
  }
  const parts = [head]
  if (error instanceof AggregateError) {
    for (const inner of error.errors.slice(0, MAX_AGGREGATE_ERRORS)) {
      parts.push(`[aggregated] ${describeFailure(inner, depth + 1)}`)
    }
  }
  if (error.cause !== undefined) {
    parts.push(`[cause] ${describeFailure(error.cause, depth + 1)}`)
  }
  return parts.join('\n')
}

/** What failed, without anything it said: its class and, for system errors, its code. */
function errorKind(error: unknown): string {
  if (!(error instanceof Error)) {
    return typeof error
  }
  const code = errorCode(error)
  return code === undefined ? error.name : `${error.name} ${code}`
}

function errorCode(error: Error): string | number | undefined {
  const code = 'code' in error ? error.code : undefined
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}
