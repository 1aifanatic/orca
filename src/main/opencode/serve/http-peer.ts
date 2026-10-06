import { OpenCodeHttpError, openCodeMediaType, readOpenCodeHttpText } from './http-response'
import { OpenCodeSseFrames, type OpenCodeSseFrame } from './sse-frames'
import { awaitOpenCodeHttp, openCodeHttpDeadline } from './http-lifetime'
import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from '../../../shared/node-bounded-json-stringify'

export type OpenCodeHttpPeerOptions = {
  port: number
  password: string
  fetch?: typeof fetch
  requestTimeoutMs?: number
  maxResponseBytes?: number
  maxPendingRequests?: number
}

export type OpenCodeHttpRequest = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
}

/** One execution-host loopback peer; failed mutations are never retried here. */
export class OpenCodeHttpPeer {
  private readonly cancellation = new AbortController()
  private readonly baseUrl: string
  private readonly authorization: string
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number
  private readonly maxResponseBytes: number
  private readonly maxPendingRequests: number
  private pending = 0
  private eventStreamOpen = false

  constructor(options: OpenCodeHttpPeerOptions) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
      throw new RangeError('OpenCode peer requires an explicit TCP port')
    }
    this.baseUrl = `http://127.0.0.1:${options.port}`
    this.authorization = `Basic ${Buffer.from(`opencode:${options.password}`, 'utf8').toString('base64')}`
    this.fetchImpl = options.fetch ?? fetch
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.maxResponseBytes = options.maxResponseBytes ?? 16 * 1024 * 1024
    this.maxPendingRequests = options.maxPendingRequests ?? 64
    for (const limit of [this.maxResponseBytes, this.maxPendingRequests]) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new RangeError('OpenCode limit must be positive')
      }
    }
  }

  close(): void {
    this.cancellation.abort()
  }

  async request(path: string, request: OpenCodeHttpRequest = {}): Promise<Response> {
    if (this.cancellation.signal.aborted) {
      throw new OpenCodeHttpError('closed', 'OpenCode HTTP peer is closed')
    }
    if (this.pending >= this.maxPendingRequests) {
      throw new OpenCodeHttpError('capacity', 'OpenCode HTTP request capacity exceeded')
    }
    let body: string | undefined
    try {
      body =
        request.body === undefined
          ? undefined
          : stringifyJsonWithinByteLimit(request.body, this.maxResponseBytes).serialized
    } catch (error) {
      if (error instanceof JsonStringifyByteLimitError) {
        throw new OpenCodeHttpError('capacity', 'OpenCode HTTP request exceeds limit')
      }
      throw new OpenCodeHttpError('invalid-response', 'OpenCode request is not serializable JSON')
    }
    const deadline = openCodeHttpDeadline(request.timeoutMs ?? this.requestTimeoutMs)
    const signal = AbortSignal.any([
      this.cancellation.signal,
      deadline.signal,
      ...(request.signal ? [request.signal] : [])
    ])
    this.pending += 1
    try {
      signal.throwIfAborted()
      const response = await awaitOpenCodeHttp(
        this.fetchImpl(this.url(path), {
          method: request.method ?? 'GET',
          headers: {
            authorization: this.authorization,
            ...(body === undefined ? {} : { 'content-type': 'application/json' })
          },
          body,
          redirect: 'error',
          signal
        }),
        signal
      )
      const text = await readOpenCodeHttpText(response, this.maxResponseBytes, signal)
      // A detached response keeps parsing inside the same request deadline and byte budget.
      return new Response(text || null, { status: response.status, headers: response.headers })
    } catch (error) {
      if (error instanceof OpenCodeHttpError) {
        throw error
      }
      throw new OpenCodeHttpError('transport', 'OpenCode HTTP request did not complete')
    } finally {
      this.pending -= 1
      deadline.dispose()
    }
  }

  async json(path: string, request: OpenCodeHttpRequest = {}): Promise<unknown> {
    const response = await this.request(path, request)
    if (!response.ok) {
      throw new OpenCodeHttpError(
        'status',
        `OpenCode returned HTTP ${response.status}`,
        response.status
      )
    }
    if (response.status === 204) {
      return undefined
    }
    if (openCodeMediaType(response) !== 'application/json') {
      throw new OpenCodeHttpError('invalid-response', 'OpenCode did not return JSON')
    }
    try {
      const value: unknown = JSON.parse(await response.text())
      return value
    } catch {
      throw new OpenCodeHttpError('invalid-response', 'OpenCode returned invalid JSON')
    }
  }

  async events(
    path: string,
    onFrame: (frame: OpenCodeSseFrame) => Promise<void>,
    signal: AbortSignal
  ): Promise<void> {
    if (this.eventStreamOpen) {
      throw new OpenCodeHttpError('capacity', 'OpenCode event stream is open')
    }
    this.eventStreamOpen = true
    const stream = new AbortController()
    const joined = AbortSignal.any([this.cancellation.signal, signal, stream.signal])
    const opening = openCodeHttpDeadline(this.requestTimeoutMs)
    const openingSignal = AbortSignal.any([joined, opening.signal])
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      joined.throwIfAborted()
      const response = await awaitOpenCodeHttp(
        this.fetchImpl(this.url(path), {
          headers: { authorization: this.authorization, accept: 'text/event-stream' },
          redirect: 'error',
          signal: joined
        }),
        openingSignal
      )
      opening.dispose()
      if (!response.ok || openCodeMediaType(response) !== 'text/event-stream' || !response.body) {
        void response.body?.cancel().catch(() => {})
        throw new OpenCodeHttpError('status', 'OpenCode event stream was refused', response.status)
      }
      reader = response.body.getReader()
      const frames = new OpenCodeSseFrames(this.maxResponseBytes)
      const decoder = new TextDecoder()
      for (;;) {
        const idle = openCodeHttpDeadline(120_000)
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await awaitOpenCodeHttp(reader.read(), AbortSignal.any([joined, idle.signal]))
        } finally {
          idle.dispose()
        }
        if (chunk.done) {
          throw new OpenCodeHttpError('transport', 'OpenCode event stream ended')
        }
        for (const frame of frames.push(decoder.decode(chunk.value, { stream: true }))) {
          joined.throwIfAborted()
          await awaitOpenCodeHttp(onFrame(frame), joined)
        }
      }
    } catch (error) {
      if (joined.aborted) {
        return
      }
      if (error instanceof OpenCodeHttpError) {
        throw error
      }
      throw new OpenCodeHttpError('transport', 'OpenCode event stream failed')
    } finally {
      opening.dispose()
      stream.abort()
      void reader?.cancel().catch(() => {})
      try {
        reader?.releaseLock()
      } catch {}
      this.eventStreamOpen = false
    }
  }

  private url(path: string): string {
    const url = new URL(path, this.baseUrl)
    if (!path.startsWith('/') || url.origin !== this.baseUrl) {
      throw new OpenCodeHttpError(
        'invalid-response',
        'OpenCode path must remain on its owned server'
      )
    }
    return url.href
  }
}
