import { z } from 'zod'

/** One `sessions` row as SQLite returned it; the main thread maps it into a run. */
export type HermesSessionRow = Record<string, unknown>

/** One cron run's session row and its messages, oldest first. */
export type HermesSessionRunRows = {
  id: string
  session: HermesSessionRow
  messages: HermesSessionRow[]
}

/** No session rows: what both Hermes reads have always answered when state.db can't be read. */
export function hermesSessionRowsFailure(): HermesSessionRow[] {
  return []
}

export function hermesSessionRunsFailure(): HermesSessionRunRows[] {
  return []
}

const rowSchema = z.record(z.string(), z.unknown())
const rowsSchema = z.array(rowSchema)
const runsSchema = z.array(
  z.object({ id: z.string(), session: rowSchema, messages: z.array(rowSchema) })
)

/** A worker reply arrives as a structured clone; null when it is not a list of rows. */
export function parseHermesSessionRows(value: unknown): HermesSessionRow[] | null {
  const parsed = rowsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** A worker reply arrives as a structured clone; null when it is not a list of session runs. */
export function parseHermesSessionRuns(value: unknown): HermesSessionRunRows[] | null {
  const parsed = runsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
