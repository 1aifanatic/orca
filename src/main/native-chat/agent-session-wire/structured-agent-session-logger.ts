// Where the structured chat host and its runtime report a failure they carry on past.
//
// One required dependency rather than a callback per failure: a host built without it does not
// compile, so no failure path can quietly drop what went wrong. The default writes each entry to
// the app's local trace file (`<userData>/logs/main.trace.ndjson`, collected by the diagnostic
// bundle) and to the console, which is stderr under a supervised headless host.

import { startSpan } from '../../observability/tracer'

export type StructuredAgentSessionLogFields = {
  /** The step that failed; a stable name a log search can find. */
  readonly scope: string
  readonly sessionId?: string
  readonly error?: unknown
  readonly [field: string]: unknown
}

export type StructuredAgentSessionLogger = {
  warn: (message: string, fields: StructuredAgentSessionLogFields) => void
  error: (message: string, fields: StructuredAgentSessionLogFields) => void
}

type LogLevel = keyof StructuredAgentSessionLogger

const guarded = new WeakSet<StructuredAgentSessionLogger>()

/** Reporting is bookkeeping: a logger that throws must never fail the operation it reports. */
export function neverThrowingStructuredAgentSessionLogger(
  logger: StructuredAgentSessionLogger
): StructuredAgentSessionLogger {
  if (guarded.has(logger)) {
    return logger
  }
  const call =
    (level: LogLevel) =>
    (message: string, fields: StructuredAgentSessionLogFields): void => {
      try {
        logger[level](message, fields)
      } catch (loggerError) {
        try {
          console.warn(`[agent-session] ${message}`, { ...fields, loggerError })
        } catch {
          // Nothing is left to report to.
        }
      }
    }
  const safe: StructuredAgentSessionLogger = { warn: call('warn'), error: call('error') }
  guarded.add(safe)
  return safe
}

/** A copy of `deps` whose logger cannot throw; every collaborator built from it inherits that. */
export function withNeverThrowingLogger<T extends { logger: StructuredAgentSessionLogger }>(
  deps: T
): T {
  return { ...deps, logger: neverThrowingStructuredAgentSessionLogger(deps.logger) }
}

/** A `(sessionId, error)` reporter for a collaborator that reports per session. Lazy, for a host
 *  that wires its collaborators before its own deps are assigned. */
export function logSessionFailure(
  logger: () => StructuredAgentSessionLogger,
  scope: string,
  message: string
): (sessionId: string, error: unknown) => void {
  return (sessionId, error) => logger().warn(message, { scope, sessionId, error })
}

/** The production logger: a failed span in the local trace file, plus the console. */
export function createStructuredAgentSessionLogger(): StructuredAgentSessionLogger {
  const write =
    (level: LogLevel) =>
    (message: string, fields: StructuredAgentSessionLogFields): void => {
      const { scope, error, ...rest } = fields
      const span = startSpan(`agentSession.${scope}`, {
        attributes: {
          level,
          message,
          ...rest,
          // An Error's own fields do not enumerate; the span's failure cause carries its stack.
          ...(error !== undefined && !(error instanceof Error) ? { error } : {})
        }
      })
      span.fail(error instanceof Error ? error : message)
      const print = level === 'error' ? console.error : console.warn
      print(`[agent-session] ${scope}: ${message}`, fields)
    }
  return neverThrowingStructuredAgentSessionLogger({ warn: write('warn'), error: write('error') })
}
