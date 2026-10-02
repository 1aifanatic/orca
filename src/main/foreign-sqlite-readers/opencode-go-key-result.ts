import { z } from 'zod'

/** `unreadable`: no database held a key and at least one failed to open or query. */
export type OpenCodeGoKeyReadResult =
  | { status: 'found'; key: string }
  | { status: 'missing' }
  | { status: 'unreadable' }

/** Also the value when the worker cannot answer: an unread store is not an empty one. */
export function openCodeGoKeyReadFailure(): OpenCodeGoKeyReadResult {
  return { status: 'unreadable' }
}

const resultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('found'), key: z.string().min(1) }),
  z.object({ status: z.literal('missing') }),
  z.object({ status: z.literal('unreadable') })
])

/** A worker reply arrives as a structured clone; null when it is not a Go key read result. */
export function parseOpenCodeGoKeyReadResult(value: unknown): OpenCodeGoKeyReadResult | null {
  const parsed = resultSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
