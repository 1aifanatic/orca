// Where a structured chat session's background failures go. Every catch site in that code reports
// here with its own step, so no failure depends on a caller having wired a sink: the trace file is
// installed once at startup, and the diagnostic bundle ships it. The console line is for dev runs;
// a packaged main process owns no console.

import { startSpan } from './tracer'

/** Closed so trace readers can rely on the vocabulary; add a step here with its catch site. */
export type AgentSessionFailureStep =
  // Provider lifecycle delivered to the host.
  | 'provider-started-settlement'
  | 'provider-exit-settlement'
  | 'provider-exit-barrier'
  | 'provider-exit-lease-release'
  | 'provider-start'
  | 'started-options-persist'
  | 'late-dispatch-settlement'
  | 'unanswered-dispatch-release'
  | 'dead-generation-settlement'
  | 'sink-failure-recovery'
  | 'operation-agent-start'
  // The journal and what writes through it.
  | 'event-sink'
  | 'journal-delivery'
  | 'journal-database-open'
  | 'journal-open-read'
  | 'journal-open-write'
  | 'journal-open-pending-doubt'
  | 'journal-rollback'
  | 'journal-row-bookkeeping'
  | 'legacy-journal-import'
  | 'legacy-journal-retire'
  | 'gone-generation-settlement'
  | 'death-evidence-resettle'
  | 'restart-reconciliation'
  // Leases.
  | 'lease-probe'
  | 'lease-renewal'
  // Delivery, queued drafts and Stop.
  | 'delivery-wake'
  | 'delivery-loop'
  | 'delivery-loop-failure-settlement'
  | 'idle-sweep'
  | 'queued-drain'
  | 'queued-owed-settlement'
  | 'queued-repair'
  | 'queued-abandon'
  | 'queue-pause-retire'
  | 'clear-draft-carry'
  | 'stop-owed-settlement'
  | 'stop-queue-pause'
  | 'operation-uncertainty-persist'
  | 'refused-operation-settlement'
  | 'rewind-recovery'
  // Status projection.
  | 'status-publish'
  | 'status-forget'
  | 'status-observer'
  | 'child-work-publish'
  // Restart recovery.
  | 'recovery-capsule-read'
  | 'recovery-capsule-record'
  | 'recovery-witness-begin'
  | 'recovery-witness-capture'
  | 'recovery-records-forget'
  | 'restart-offer-prune'
  | 'restart-offer-withdraw'
  | 'restart-offer-complete'
  | 'restart-offer-rollback'
  | 'restart-offer-refresh'
  | 'restart-failure-record'
  | 'restart-continuation-send'
  | 'restart-continuation-note'
  // Chat tabs.
  | 'tab-visibility-restore'
  | 'worker-tab-retire'

export type AgentSessionFailureReport = {
  step: AgentSessionFailureStep
  sessionId?: string
  error: unknown
  /** Ids and closed-vocabulary facts only; attributes pass through the trace redactor. */
  detail?: Record<string, string | number | boolean>
}

/** Their errors can quote the recovery capsule (the user's latest prompt) or unbounded disk detail,
 *  so they record the error's kind, never its text. */
const KIND_ONLY_STEPS: ReadonlySet<AgentSessionFailureStep> = new Set<AgentSessionFailureStep>([
  'operation-uncertainty-persist',
  'refused-operation-settlement',
  'recovery-capsule-read',
  'recovery-capsule-record',
  'recovery-witness-begin',
  'recovery-witness-capture',
  'recovery-records-forget',
  'restart-offer-prune',
  'restart-offer-withdraw',
  'restart-offer-complete',
  'restart-offer-rollback',
  'restart-offer-refresh',
  'restart-failure-record',
  'restart-continuation-send',
  'restart-continuation-note'
])

const SPAN_NAME = 'agent-session.failure'
const MAX_CAUSE_DEPTH = 5
const MAX_AGGREGATE_ERRORS = 10

/** Never throws: reporting is bookkeeping and must not replace the failure it describes. */
export function reportAgentSessionFailure(report: AgentSessionFailureReport): void {
  const { step, sessionId, error, detail } = report
  const kindOnly = KIND_ONLY_STEPS.has(step)
  const context = { ...(sessionId === undefined ? {} : { sessionId }), ...detail }
  try {
    startSpan(SPAN_NAME, { attributes: { step, ...context } }).fail(
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
  const head = error.stack ?? `${error.name}: ${error.message}`
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
  const { code } = error as { code?: unknown }
  return typeof code === 'string' || typeof code === 'number' ? `${error.name} ${code}` : error.name
}
