import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalWriter } from './runtime-terminal-writer'
import { PtyInputTransactions } from './pty-input-transactions'
import { WRITE_ACCEPTED, writeRefused } from '../../shared/pty-write-settlement'

afterEach(() => vi.useRealTimers())

function harness() {
  const bytes: string[] = []
  const transactions = new PtyInputTransactions()
  const binding = { key: 'pty', isCurrent: () => true }
  const provider = vi.fn((_id: string, data: string) => {
    bytes.push(data)
    return WRITE_ACCEPTED
  })
  const writer = new RuntimeTerminalWriter(
    (_id, data) => {
      bytes.push(data)
      return true
    },
    () => 'linux',
    () => null,
    provider,
    () => binding,
    transactions
  )
  const send = (text: string, signal?: AbortSignal) =>
    writer.writeAction('pty', { text, enter: true }, `${text}\r`, {
      inputKind: 'driving',
      requireWriteSettlement: true,
      signal
    })
  return { bytes, transactions, binding, provider, writer, send }
}

describe('terminal send input transactions', () => {
  it('owns text through Enter and queues raw keystrokes behind both sends', async () => {
    vi.useFakeTimers()
    const h = harness()
    const a = h.send('A')
    await vi.advanceTimersByTimeAsync(0)
    const b = h.send('B')
    const key = h.transactions.run(h.binding, () => h.bytes.push('key'))
    expect(h.bytes).toEqual(['A'])
    await vi.runAllTimersAsync()
    await Promise.all([a, b, key])
    expect(h.bytes).toEqual(['A', '\r', 'B', '\r', 'key'])
    expect(h.transactions.size).toBe(0)
  })

  it('aborts queued sends without bytes and finishes after a started send loses its caller', async () => {
    vi.useFakeTimers()
    const h = harness()
    const started = new AbortController()
    const queued = new AbortController()
    const a = h.send('A', started.signal)
    await vi.advanceTimersByTimeAsync(0)
    const b = h.send('B', queued.signal)
    const aborted = expect(b).rejects.toThrow('request_aborted')
    queued.abort()
    started.abort()
    await aborted
    await vi.runAllTimersAsync()
    expect(await a).toEqual(WRITE_ACCEPTED)
    expect(h.bytes).toEqual(['A', '\r'])
    expect(h.transactions.size).toBe(0)
  })

  it('preempts a suffix, delivers Ctrl-C, then runs the queued send', async () => {
    vi.useFakeTimers()
    const h = harness()
    const a = h.send('A')
    await vi.advanceTimersByTimeAsync(0)
    const b = h.send('B')
    const interrupt = h.writer.writeChunks('pty', '\x03', { inputKind: 'driving' })
    await vi.runAllTimersAsync()
    expect(await a).toMatchObject({ outcome: 'unverifiable', reason: 'partial_write' })
    await Promise.all([b, interrupt])
    expect(h.bytes).toEqual(['A', '\x03', 'B', '\r'])
    expect(h.transactions.size).toBe(0)
  })

  it('does not preempt for a send-owned interrupt suffix', async () => {
    vi.useFakeTimers()
    const h = harness()
    const a = h.send('A')
    await vi.advanceTimersByTimeAsync(0)
    const b = h.writer.writeAction('pty', { text: 'B', interrupt: true }, 'B\x03', {
      inputKind: 'driving',
      requireWriteSettlement: true
    })
    await vi.runAllTimersAsync()
    await Promise.all([a, b])
    expect(h.bytes).toEqual(['A', '\r', 'B', '\x03'])
  })

  it('releases provider refusals and failures so the next send runs', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.provider.mockReturnValueOnce(writeRefused('provider_refused_write'))
    const a = h.send('A')
    const b = h.send('B')
    await vi.runAllTimersAsync()
    expect(await a).toMatchObject({ outcome: 'refused' })
    expect(await b).toEqual(WRITE_ACCEPTED)
    h.provider.mockImplementationOnce(() => {
      throw new Error('provider failed')
    })
    const c = h.send('C')
    const d = h.send('D')
    await vi.runAllTimersAsync()
    expect(await c).toMatchObject({ outcome: 'unverifiable' })
    expect(await d).toEqual(WRITE_ACCEPTED)
    expect(h.transactions.size).toBe(0)
  })
})
