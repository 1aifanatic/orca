import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentPresenceCommandObserver } from './agent-presence-command-observer'
import { captureAgentForegroundIdentity } from './agent-foreground-identity'

afterEach(() => vi.useRealTimers())

describe('one foreground observation per command', () => {
  it('costs zero while idle, coalesces markers, and stops after one cached resolver read', async () => {
    vi.useFakeTimers()
    const resolve = vi.fn(async () => ({ available: true, processName: 'sleep' }))
    const observer = new AgentPresenceCommandObserver(async () => {
      await captureAgentForegroundIdentity(resolve)
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(resolve).not.toHaveBeenCalled()
    observer.start('pane')
    observer.start('pane')
    await vi.advanceTimersByTimeAsync(999)
    expect(resolve).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(resolve).toHaveBeenCalledTimes(1)
    observer.start('pane')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(resolve).toHaveBeenCalledTimes(1)
    observer.stop()
  })

  it('cancels on command end, changed incarnation, or acquired owner', async () => {
    vi.useFakeTimers()
    const observe = vi.fn(async () => {})
    const observer = new AgentPresenceCommandObserver(observe)
    observer.start('short')
    observer.end('short')
    let current = true
    observer.start('old', () => current)
    current = false
    observer.start('owned', () => false)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(observe).not.toHaveBeenCalled()
    observer.stop()
  })

  it('fences an in-flight result after end and a new command on the same terminal', async () => {
    vi.useFakeTimers()
    let current: (() => boolean) | undefined
    const observer = new AgentPresenceCommandObserver(async (_id, active) => {
      current = active
    })
    observer.start('pane')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(current?.()).toBe(true)
    observer.end('pane')
    observer.start('pane')
    expect(current?.()).toBe(false)
    observer.stop()
  })
})
