import { afterEach, describe, expect, it, vi } from 'vitest'
import { PtyInputTransactions } from './pty-input-transactions'
import { resolvePtyInputHoldMs } from './pty-input-hold'
import { RuntimeTerminalWriter } from './runtime-terminal-writer'
import { resolveAgentPromptSubmitDelayForAgent } from '../../shared/agent-prompt-injection'

afterEach(() => vi.useRealTimers())

const binding = { key: 'bounded-input', isCurrent: () => true }

describe('bounded PTY input ownership', () => {
  it('expires a queued request at its own deadline without running it', async () => {
    vi.useFakeTimers()
    const queue = new PtyInputTransactions()
    const active = queue.run(binding, () => new Promise<void>(() => {}))
    const abandoned = expect(active).rejects.toMatchObject({
      message: 'request_timeout',
      bytesHandedToTransport: false
    })
    const write = vi.fn()
    const deadlineAt = Date.now() + 100
    const pending = queue.run(binding, write, { deadlineAt })
    const expired = expect(pending).rejects.toThrow('request_timeout')
    const key = vi.fn(() => 'key')
    const typing = queue.run(binding, key)
    await vi.advanceTimersByTimeAsync(100)
    await expired
    expect(write).not.toHaveBeenCalled()
    expect(key).not.toHaveBeenCalled()
    expect(queue.size).toBe(1)
    await vi.advanceTimersByTimeAsync(resolvePtyInputHoldMs() - 100)
    await abandoned
    expect(await typing).toBe('key')
    expect(queue.size).toBe(0)
    expect(() => queue.run(binding, write, { deadlineAt })).toThrow('request_timeout')
    expect(write).not.toHaveBeenCalled()
    expect(queue.size).toBe(0)
  })

  it('starts the hold on acquisition and allows the full scheduled delay after waiting', async () => {
    vi.useFakeTimers()
    const queue = new PtyInputTransactions()
    let release: () => void = () => {}
    const active = queue.run(
      binding,
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
      {
        hold: { writeCount: 1, delayMs: 3_000 }
      }
    )
    const bytes: string[] = []
    const delayMs = 3_000
    const next = queue.run(
      binding,
      async (tx) => {
        tx.handoff()
        bytes.push('text')
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
        tx.handoff()
        bytes.push('submit')
      },
      { hold: { writeCount: 2, delayMs } }
    )
    const key = queue.run(binding, () => bytes.push('key'))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(bytes).toEqual([])
    release()
    await active
    const acquiredAt = Date.now()
    const holdFromEnqueueMs = resolvePtyInputHoldMs({ writeCount: 2, delayMs })
    await vi.advanceTimersByTimeAsync(holdFromEnqueueMs - 2_000)
    expect(bytes).toEqual(['text'])
    expect(queue.size).toBe(1)
    await vi.advanceTimersByTimeAsync(acquiredAt + delayMs - Date.now())
    await Promise.all([next, key])
    expect(bytes).toEqual(['text', 'submit', 'key'])
    expect(queue.size).toBe(0)
  })

  it('checks the absolute fence before a late byte even before the timer callback runs', async () => {
    vi.useFakeTimers()
    const queue = new PtyInputTransactions()
    let release: () => void = () => {}
    const stalled = new Promise<void>((resolve) => {
      release = resolve
    })
    const bytes: string[] = []
    const active = queue.run(binding, async (tx) => {
      tx.handoff()
      bytes.push('text')
      await stalled
      tx.handoff()
      bytes.push('submit')
    })
    const abandoned = expect(active).rejects.toMatchObject({
      message: 'partial_write',
      bytesHandedToTransport: true
    })
    const key = queue.run(binding, () => bytes.push('key'))
    vi.setSystemTime(Date.now() + resolvePtyInputHoldMs())
    release()
    await Promise.all([abandoned, key])
    expect(bytes).toEqual(['text', 'key'])
    expect(queue.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows a large Windows send to finish its computed ingest delay before typing', async () => {
    vi.useFakeTimers()
    const queue = new PtyInputTransactions()
    const bytes: string[] = []
    let lastTextChunkAt = 0
    let submittedAt = 0
    const writer = new RuntimeTerminalWriter(
      (_id, data) => {
        bytes.push(data)
        if (data === '\r') {
          submittedAt = Date.now()
        } else {
          lastTextChunkAt = Date.now()
        }
        return true
      },
      () => 'win32',
      () => null,
      undefined,
      () => binding,
      queue
    )
    const text = 'x'.repeat(320_000)
    const delayMs = resolveAgentPromptSubmitDelayForAgent('win32', text, null)
    let finished = false
    const send = writer
      .writeAction('pty', { text, enter: true }, `${text}\r`, { inputKind: 'driving' })
      .then((value) => {
        finished = true
        return value
      })
    await vi.advanceTimersByTimeAsync(100)
    expect(bytes.join('')).toBe(text)
    const key = queue.run(binding, (tx) => {
      tx.handoff()
      bytes.push('key')
    })
    const ingestDeadlineAt = lastTextChunkAt + delayMs
    await vi.advanceTimersByTimeAsync(ingestDeadlineAt - Date.now() - 1)
    expect(finished).toBe(false)
    expect(bytes.join('')).toBe(text)
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([send, key])
    expect(bytes.join('')).toBe(`${text}\rkey`)
    expect(submittedAt).toBeGreaterThanOrEqual(ingestDeadlineAt)
    expect(queue.size).toBe(0)
  })
})
