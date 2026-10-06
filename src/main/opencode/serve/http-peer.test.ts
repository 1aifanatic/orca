import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenCodeHttpPeer } from './http-peer'

afterEach(() => vi.useRealTimers())

function peer(
  fetchImpl: typeof fetch,
  options: {
    maxResponseBytes?: number
    maxPendingRequests?: number
    consumerTimeoutMs?: number
  } = {}
) {
  return new OpenCodeHttpPeer({ port: 48271, password: 'pässwörd', fetch: fetchImpl, ...options })
}

describe('OpenCode HTTP peer', () => {
  it('uses UTF-8 Basic auth, refuses off-server paths and does not follow redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: true }))
    const connection = peer(fetchImpl)
    await expect(connection.json('/session')).resolves.toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:48271/session',
      expect.objectContaining({
        headers: { authorization: `Basic ${Buffer.from('opencode:pässwörd').toString('base64')}` },
        redirect: 'error'
      })
    )
    await expect(connection.request('//foreign.example/api')).rejects.toMatchObject({
      kind: 'invalid-response'
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    connection.close()
  })

  it('bounds decoded response bytes and rejects non-JSON success', async () => {
    const connection = peer(async () => new Response('€'.repeat(3)), { maxResponseBytes: 8 })
    await expect(connection.request('/large')).rejects.toMatchObject({ kind: 'invalid-response' })
    connection.close()
    const html = peer(
      async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })
    )
    await expect(html.json('/session')).rejects.toThrow('did not return JSON')
    html.close()
  })

  it('reports a refused mutation separately from a transport failure and never retries either', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 400 }))
    const connection = peer(fetchImpl)
    await expect(
      connection.json('/session', { method: 'POST', body: { text: 'hello' } })
    ).rejects.toMatchObject({ kind: 'status', status: 400 })
    expect(fetchImpl).toHaveBeenCalledOnce()
    connection.close()
    const failedFetch = vi.fn<typeof fetch>(async () => {
      throw new Error('credential-bearing fetch error')
    })
    const failed = peer(failedFetch)
    await expect(failed.json('/session', { method: 'POST', body: {} })).rejects.toMatchObject({
      kind: 'transport',
      message: 'OpenCode HTTP request did not complete'
    })
    expect(failedFetch).toHaveBeenCalledOnce()
    failed.close()
  })

  it('stops serializing a request at its byte limit before sending it', async () => {
    let visits = 0
    const body = Array.from({ length: 100 }, () => ({
      toJSON() {
        visits += 1
        return 'value'
      }
    }))
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: true }))
    const connection = peer(fetchImpl, { maxResponseBytes: 64 })
    await expect(connection.request('/session', { method: 'POST', body })).rejects.toMatchObject({
      kind: 'capacity'
    })
    expect(visits).toBeLessThan(body.length)
    expect(fetchImpl).not.toHaveBeenCalled()
    connection.close()
  })

  it('releases stalled request capacity on timeout and close, with no timers left', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}))
    const connection = peer(fetchImpl, { maxPendingRequests: 1 })
    const first = expect(connection.request('/first', { timeoutMs: 20 })).rejects.toMatchObject({
      kind: 'transport'
    })
    await expect(connection.request('/second')).rejects.toMatchObject({ kind: 'capacity' })
    await vi.advanceTimersByTimeAsync(20)
    await first
    const third = expect(connection.request('/third')).rejects.toMatchObject({ kind: 'transport' })
    connection.close()
    await third
    await expect(connection.request('/fourth')).rejects.toMatchObject({ kind: 'closed' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a response that stalls after headers', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const connection = peer(async () => new Response(new ReadableStream({ cancel })))
    const request = expect(
      connection.request('/stalled-body', { timeoutMs: 20 })
    ).rejects.toMatchObject({ kind: 'transport' })
    await vi.advanceTimersByTimeAsync(20)
    await request
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    connection.close()
  })
})

describe('OpenCode event stream', () => {
  it('bounds a stalled consumer and releases the stream for a new subscription', async () => {
    vi.useFakeTimers()
    const cancelled = vi.fn()
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: one\n\n'))
            },
            cancel: cancelled
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
    )
    const connection = peer(fetchImpl, { consumerTimeoutMs: 20 })
    const stalled = expect(
      connection.events('/event', () => new Promise<void>(() => {}), new AbortController().signal)
    ).rejects.toMatchObject({ kind: 'consumer' })
    await vi.advanceTimersByTimeAsync(20)
    await stalled
    expect(cancelled).toHaveBeenCalledOnce()
    const signal = new AbortController()
    await connection.events('/event', async () => signal.abort(), signal.signal)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    connection.close()
  })

  it('keeps framing limits and consumer faults separate from network loss', async () => {
    const stream = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: payload\n\n'))
          }
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    const oversized = peer(async () => stream(), { maxResponseBytes: 8 })
    await expect(
      oversized.events('/event', async () => {}, new AbortController().signal)
    ).rejects.toMatchObject({ kind: 'capacity' })
    oversized.close()
    const broken = peer(async () => stream())
    const cause = new Error('consumer failure')
    await expect(
      broken.events(
        '/event',
        async () => {
          throw cause
        },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ kind: 'consumer', cause })
    broken.close()
  })

  it('decodes split UTF-8 and the BOM, and forwards child events without filtering', async () => {
    const signal = new AbortController()
    const frames: string[] = []
    const bytes = new TextEncoder().encode('\ufeffdata: {"child":"€"}\r\n\r\n')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) {
          controller.enqueue(Uint8Array.of(byte))
        }
      }
    })
    const connection = peer(
      async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    )
    await connection.events(
      '/event',
      async (frame) => {
        frames.push(frame.data)
        signal.abort()
      },
      signal.signal
    )
    expect(frames).toEqual(['{"child":"€"}'])
    connection.close()
  })

  it('awaits the consumer before delivering another frame and cancels a blocked consumer on close', async () => {
    let releaseFirst = (): void => {}
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let observeFirst = (): void => {}
    const observed = new Promise<void>((resolve) => {
      observeFirst = resolve
    })
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: one\n\ndata: two\n\n'))
      },
      cancel
    })
    const connection = peer(
      async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    )
    const calls: string[] = []
    const consuming = connection.events(
      '/event',
      async (frame) => {
        calls.push(frame.data)
        observeFirst()
        await first
      },
      new AbortController().signal
    )
    await observed
    expect(calls).toEqual(['one'])
    connection.close()
    await consuming
    expect(calls).toEqual(['one'])
    expect(cancel).toHaveBeenCalledOnce()
    releaseFirst()
  })

  it('reports an unexpected EOF instead of reconnecting or pretending the process exited', async () => {
    const connection = peer(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.close()
            }
          }),
          {
            headers: { 'content-type': 'text/event-stream' }
          }
        )
    )
    await expect(
      connection.events('/event', async () => {}, new AbortController().signal)
    ).rejects.toMatchObject({ kind: 'transport', message: 'OpenCode event stream ended' })
    connection.close()
  })

  it('bounds event headers and silent streams and clears deadlines after cancellation', async () => {
    vi.useFakeTimers()
    const never = peer(() => new Promise<Response>(() => {}))
    const opening = expect(
      never.events('/event', async () => {}, new AbortController().signal)
    ).rejects.toMatchObject({ kind: 'transport' })
    await vi.advanceTimersByTimeAsync(30_000)
    await opening
    never.close()
    const cancel = vi.fn()
    const silent = peer(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { 'content-type': 'text/event-stream' }
        })
    )
    const reading = expect(
      silent.events('/event', async () => {}, new AbortController().signal)
    ).rejects.toMatchObject({ kind: 'transport' })
    await vi.advanceTimersByTimeAsync(120_000)
    await reading
    silent.close()
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
