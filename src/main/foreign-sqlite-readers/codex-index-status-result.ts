import { z } from 'zod'

export type CodexStateDbBackfillStatus =
  | { kind: 'complete'; stateDbPath: string }
  | { kind: 'incomplete'; stateDbPath: string; status: string }
  | { kind: 'missing' }
  | { kind: 'not-tracked'; stateDbPath: string }
  /** `stateDbPath` is null when the reader worker could not answer. */
  | { kind: 'unreadable'; stateDbPath: string | null; error: string }

export type CodexIndexStatusResult =
  | {
      type: 'backfill'
      status: CodexStateDbBackfillStatus
      /** Null unless `status` is `missing` or `not-tracked`. */
      sessionFileCount: number | null
    }
  | { type: 'indexedThreadIds'; threadIds: string[] | null; error: string | null }
  | { type: 'sessionFileCount'; count: number }

const statusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('complete'), stateDbPath: z.string() }),
  z.object({ kind: z.literal('incomplete'), stateDbPath: z.string(), status: z.string() }),
  z.object({ kind: z.literal('missing') }),
  z.object({ kind: z.literal('not-tracked'), stateDbPath: z.string() }),
  z.object({ kind: z.literal('unreadable'), stateDbPath: z.string().nullable(), error: z.string() })
])

const count = z.number().int().nonnegative()

const resultSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('backfill'),
    status: statusSchema,
    sessionFileCount: count.nullable()
  }),
  z.object({
    type: z.literal('indexedThreadIds'),
    threadIds: z.array(z.string()).nullable(),
    error: z.string().nullable()
  }),
  z.object({ type: z.literal('sessionFileCount'), count })
])

/** A worker reply arrives as a structured clone; null when it is not a Codex index result. */
export function parseCodexIndexStatusResult(value: unknown): CodexIndexStatusResult | null {
  const parsed = resultSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
