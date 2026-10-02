import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentPresenceCommandObserver,
  type AgentPresenceObservationKind
} from './agent-presence-command-observer'
import { captureAgentForegroundIdentity } from './agent-foreground-identity'

afterEach(() => vi.useRealTimers())
const observeMock = () =>
  vi.fn(
    async (
      _id: string,
      _current: () => boolean,
      _kind: AgentPresenceObservationKind,
      _evidenceAtMs: number
    ) => {}
  )

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
    await vi.advanceTimersByTimeAsync(60_000)
    expect(resolve).toHaveBeenCalledTimes(1)
    // A command-start after the read ran is the next command, even when no command-end arrived.
    observer.start('pane')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(resolve).toHaveBeenCalledTimes(2)
    observer.stop()
  })

  it('reads once per command and agent for evidence, and every command resets the key', async () => {
    vi.useFakeTimers()
    const observe = observeMock()
    const observer = new AgentPresenceCommandObserver(observe)
    for (let i = 0; i < 20; i += 1) {
      observer.evidence('pane', 'claude')
    }
    observer.evidence('pane', 'codex')
    expect(observe.mock.calls.map(([, , kind]) => kind)).toEqual(['evidence', 'evidence'])
    observer.start('pane')
    observer.evidence('pane', 'claude')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(observe.mock.calls.map(([, , kind]) => kind)).toEqual([
      'evidence',
      'evidence',
      'evidence',
      'command'
    ])
    observer.evidence('pane', 'claude')
    expect(observe).toHaveBeenCalledTimes(4)
    observer.stop()
  })

  it('keeps a delayed launch read off the command slot and cancels it with the terminal', async () => {
    vi.useFakeTimers()
    const observe = observeMock()
    const observer = new AgentPresenceCommandObserver(observe)
    observer.evidence('launched', 'codex', () => true, 1_000)
    await vi.advanceTimersByTimeAsync(500)
    observer.start('launched')
    await vi.advanceTimersByTimeAsync(500)
    expect(observe.mock.calls.map(([, , kind]) => kind)).toEqual([])
    await vi.advanceTimersByTimeAsync(500)
    expect(observe.mock.calls.map(([, , kind]) => kind)).toEqual(['command'])
    observer.evidence('gone', 'codex', () => true, 1_000)
    observer.end('gone')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(observe).toHaveBeenCalledTimes(1)
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

  it('re-checks an owned key on every evidence and backs a missed key off 5 s, 10 s, 20 s', async () => {
    vi.useFakeTimers()
    let owned = true
    const observe = vi.fn(
      async (
        _id: string,
        _current: () => boolean,
        _kind: AgentPresenceObservationKind,
        _evidenceAtMs: number
      ) => owned
    )
    const observer = new AgentPresenceCommandObserver(observe)
    for (let i = 0; i < 3; i += 1) {
      observer.evidence('pane', 'claude')
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(observe).toHaveBeenCalledTimes(3)
    owned = false
    const readAt: number[] = []
    observe.mockImplementation(async () => {
      readAt.push(Date.now())
      return false
    })
    const start = Date.now()
    for (let i = 0; i < 400; i += 1) {
      observer.evidence('pane', 'claude')
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(readAt.map((at) => Math.round((at - start) / 100) * 100)).toEqual([
      0, 5_000, 15_000, 35_000
    ])
    observer.stop()
  })

  it('reads a new run of a backed-off agent at once, while repeats of one run stay backed off', async () => {
    vi.useFakeTimers()
    const readAt: number[] = []
    const observe = vi.fn(
      async (
        _id: string,
        _current: () => boolean,
        _kind: AgentPresenceObservationKind,
        _evidenceAtMs: number
      ) => {
        readAt.push(Date.now())
        return false
      }
    )
    const observer = new AgentPresenceCommandObserver(observe)
    const start = Date.now()
    const at = () => readAt.map((t) => Math.round((t - start) / 100) * 100)
    // A storm of one session's hooks keeps the doubling bound.
    for (let i = 0; i < 200; i += 1) {
      observer.evidence('pane', 'claude', () => true, 0, { sessionId: 'a' })
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(at()).toEqual([0, 5_000, 15_000])
    // A session the key has not seen reads at once; then it backs off again.
    observer.evidence('pane', 'claude', () => true, 0, { sessionId: 'b' })
    observer.evidence('pane', 'claude', () => true, 0, { sessionId: 'b' })
    await vi.advanceTimersByTimeAsync(100)
    observer.evidence('pane', 'claude', () => true, 0, { sessionId: 'b' })
    expect(at()).toEqual([0, 5_000, 15_000, 20_000])
    // A session start reads at once even when it resumes the same session.
    await vi.advanceTimersByTimeAsync(1_000)
    observer.evidence('pane', 'claude', () => true, 0, { sessionId: 'b', started: true })
    expect(at()).toEqual([0, 5_000, 15_000, 20_000, 21_100])
    observer.stop()
  })

  it('keeps a launch key apart from the agent key it names', async () => {
    vi.useFakeTimers()
    const observe = observeMock()
    const observer = new AgentPresenceCommandObserver(observe)
    observer.evidence('pane', 'launch:claude', () => true, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    observer.evidence('pane', 'claude')
    expect(observe).toHaveBeenCalledTimes(2)
    observer.stop()
  })
})
