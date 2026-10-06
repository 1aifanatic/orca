import { OpenCodeHttpError } from './http-response'
import { openCodeObjectSchema } from './native-protocol'
import type { OpenCodeSessionClient } from './session-client'
import { openCodeHttpDeadline } from './http-lifetime'

const MAX_HISTORY_MESSAGES = 4_000
const MAX_HISTORY_BYTES = 32 * 1024 * 1024
const MAX_HISTORY_PAGES = 101

/** A short page is not EOF; the native forward cursor ends only on an empty page. */
export async function readOpenCodeHistory(
  client: OpenCodeSessionClient,
  sessionId: string
): Promise<unknown> {
  const deadline = openCodeHttpDeadline(30_000)
  try {
    return await readHistory(client, sessionId, deadline.signal)
  } finally {
    deadline.dispose()
  }
}

async function readHistory(
  client: OpenCodeSessionClient,
  sessionId: string,
  signal: AbortSignal
): Promise<unknown> {
  if (client.version.major === 1) {
    const value = await client.peer.json(client.sessionPath(sessionId, '/message'), { signal })
    if (!Array.isArray(value)) {
      throw new OpenCodeHttpError('invalid-response', 'OpenCode sent unreadable message history')
    }
    if (value.length > MAX_HISTORY_MESSAGES) {
      throw new OpenCodeHttpError('capacity', 'OpenCode history exceeds the restore limit')
    }
    return value
  }
  const messages: unknown[] = []
  const seen = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | null = null
  let bytes = 0
  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: '40', ...(cursor ? { cursor } : { order: 'asc' }) })
    const response = openCodeObjectSchema.safeParse(
      await client.peer.json(client.sessionPath(sessionId, `/message?${query}`), { signal })
    )
    if (!response.success || !Array.isArray(response.data.data)) {
      throw new OpenCodeHttpError('invalid-response', 'OpenCode sent unreadable message history')
    }
    const rows = response.data.data
    if (rows.length === 0) {
      return { data: messages, cursor: { previous: null, next: null } }
    }
    for (const row of rows) {
      const message = openCodeObjectSchema.safeParse(row)
      if (!message.success || typeof message.data.id !== 'string' || seen.has(message.data.id)) {
        throw new OpenCodeHttpError(
          'invalid-response',
          'OpenCode history repeated or omitted a message identity'
        )
      }
      seen.add(message.data.id)
      bytes += Buffer.byteLength(JSON.stringify(row))
      if (bytes > MAX_HISTORY_BYTES || messages.length >= MAX_HISTORY_MESSAGES) {
        throw new OpenCodeHttpError('capacity', 'OpenCode history exceeds the restore limit')
      }
      messages.push(row)
    }
    const next = openCodeObjectSchema.safeParse(response.data.cursor)
    if (
      !next.success ||
      typeof next.data.next !== 'string' ||
      !next.data.next ||
      cursors.has(next.data.next)
    ) {
      throw new OpenCodeHttpError(
        'invalid-response',
        'OpenCode history has an invalid forward cursor'
      )
    }
    cursor = next.data.next
    cursors.add(cursor)
  }
  throw new OpenCodeHttpError('capacity', 'OpenCode history exceeds the restore page limit')
}
