import { awaitOpenCodeHttp } from './http-lifetime'
import { appendCompactedStringChunk } from '../../../shared/string-chunk-compaction'

export class OpenCodeHttpError extends Error {
  constructor(
    readonly kind: 'transport' | 'status' | 'invalid-response' | 'closed' | 'capacity',
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'OpenCodeHttpError'
  }
}

export async function readOpenCodeHttpText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<string> {
  if (!response.body) {
    return ''
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parts: string[] = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await awaitOpenCodeHttp(reader.read(), signal)
      if (chunk.done) {
        break
      }
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) {
        throw new OpenCodeHttpError('invalid-response', 'OpenCode HTTP response exceeds limit')
      }
      appendCompactedStringChunk(parts, decoder.decode(chunk.value, { stream: true }))
    }
    appendCompactedStringChunk(parts, decoder.decode())
    return parts.join('')
  } finally {
    void reader.cancel().catch(() => {})
    // A cancelled in-flight read settles before the stream can release its lock.
    try {
      reader.releaseLock()
    } catch {}
  }
}

export function openCodeMediaType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
}
