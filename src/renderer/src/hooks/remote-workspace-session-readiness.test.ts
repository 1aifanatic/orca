import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import {
  appState,
  createHarness,
  flush,
  token
} from './__tests__/remote-workspace-target-sync-test-harness'
import { waitForRemoteWorkspaceSessionReady } from './remote-workspace-session-readiness'

function readinessStore(ready = false) {
  const store = createStore(() => appState({ workspaceSessionReady: ready }))
  const originalSubscribe = store.subscribe
  let listeners = 0
  const subscribe = vi.spyOn(store, 'subscribe').mockImplementation((listener) => {
    listeners += 1
    const unsubscribe = originalSubscribe(listener)
    return () => {
      listeners -= 1
      unsubscribe()
    }
  })
  return { store, subscribe, activeListeners: () => listeners }
}

describe('waitForRemoteWorkspaceSessionReady', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('returns immediately without resources when already ready or canceled', async () => {
    const { store, subscribe } = readinessStore(true)
    await expect(waitForRemoteWorkspaceSessionReady(store)).resolves.toBe(true)
    const controller = new AbortController()
    controller.abort()
    await expect(waitForRemoteWorkspaceSessionReady(store, controller.signal)).resolves.toBe(false)
    expect(subscribe).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses one deadline timer for ten seconds of unchanged readiness', async () => {
    const { store, activeListeners } = readinessStore()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const pending = waitForRemoteWorkspaceSessionReady(store)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toBe(false)
    expect(timers).toHaveBeenCalledTimes(1)
    expect(activeListeners()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resumes at a readiness publication between polling boundaries', async () => {
    const { store, activeListeners } = readinessStore()
    const controller = new AbortController()
    const removeAbort = vi.spyOn(controller.signal, 'removeEventListener')
    const resolved = vi.fn()
    const pending = waitForRemoteWorkspaceSessionReady(store, controller.signal).then(resolved)
    await vi.advanceTimersByTimeAsync(37)
    // The deadline is still pending, so settling here can only come from the publication.
    expect(vi.getTimerCount()).toBe(1)
    expect(resolved).not.toHaveBeenCalled()
    store.setState({ workspaceSessionReady: true })
    await flush()
    expect(resolved).toHaveBeenCalledWith(true)
    expect(activeListeners()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function))
    await vi.advanceTimersByTimeAsync(10_000)
    await pending
    expect(resolved).toHaveBeenCalledTimes(1)
  })

  it('does not restart the deadline on unrelated publications', async () => {
    const { store, activeListeners } = readinessStore()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const pending = waitForRemoteWorkspaceSessionReady(store)
    await vi.advanceTimersByTimeAsync(9_999)
    for (let index = 0; index < 1_000; index += 1) {
      store.setState({ sortEpoch: index })
    }
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe(false)
    expect(timers).toHaveBeenCalledTimes(1)
    expect(activeListeners()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('checks readiness again after installing the subscription', async () => {
    const { store, subscribe, activeListeners } = readinessStore()
    const originalSubscribe = subscribe.getMockImplementation()!
    subscribe.mockImplementation((listener) => {
      store.setState({ workspaceSessionReady: true })
      return originalSubscribe(listener)
    })
    const resolved = vi.fn()
    const pending = waitForRemoteWorkspaceSessionReady(store).then(resolved)
    await flush()
    expect(resolved).toHaveBeenCalledWith(true)
    expect(activeListeners()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await pending
  })

  it('cleans a subscription that reports readiness before returning its disposer', async () => {
    const { store, subscribe, activeListeners } = readinessStore()
    const originalSubscribe = subscribe.getMockImplementation()!
    subscribe.mockImplementation((listener) => {
      const unsubscribe = originalSubscribe(listener)
      store.setState({ workspaceSessionReady: true })
      return unsubscribe
    })
    const resolved = vi.fn()
    const pending = waitForRemoteWorkspaceSessionReady(store).then(resolved)
    await flush()
    expect(resolved).toHaveBeenCalledWith(true)
    expect(activeListeners()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await pending
  })

  it('cleans a subscription when canceled while its disposer is being installed', async () => {
    const { store, subscribe, activeListeners } = readinessStore()
    const controller = new AbortController()
    const originalSubscribe = subscribe.getMockImplementation()!
    subscribe.mockImplementation((listener) => {
      const unsubscribe = originalSubscribe(listener)
      controller.abort()
      return unsubscribe
    })
    const resolved = vi.fn()
    const pending = waitForRemoteWorkspaceSessionReady(store, controller.signal).then(resolved)
    await flush()
    expect(resolved).toHaveBeenCalledWith(false)
    expect(activeListeners()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await pending
  })

  it('releases the listener and deadline on abort before a late ready publication', async () => {
    const { store, activeListeners } = readinessStore()
    const controller = new AbortController()
    const removeAbort = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = waitForRemoteWorkspaceSessionReady(store, controller.signal)
    await vi.advanceTimersByTimeAsync(37)
    controller.abort()
    store.setState({ workspaceSessionReady: true })
    await expect(pending).resolves.toBe(false)
    expect(activeListeners()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('does not change an observed ready result after a later abort', async () => {
    const { store, activeListeners } = readinessStore()
    const controller = new AbortController()
    const resolved = vi.fn()
    const pending = waitForRemoteWorkspaceSessionReady(store, controller.signal).then(resolved)
    store.setState({ workspaceSessionReady: true })
    controller.abort()
    await pending
    expect(resolved).toHaveBeenCalledWith(true)
    expect(activeListeners()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads the latest readiness at the deadline even without a publication', async () => {
    const { store, activeListeners } = readinessStore()
    const pending = waitForRemoteWorkspaceSessionReady(store)
    await vi.advanceTimersByTimeAsync(9_999)
    store.getState().workspaceSessionReady = true
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe(true)
    expect(activeListeners()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves polling and abort for legacy stores without subscribe', async () => {
    const { store, subscribe } = readinessStore()
    const controller = new AbortController()
    const pending = waitForRemoteWorkspaceSessionReady(
      { getState: store.getState },
      controller.signal
    )
    store.setState({ workspaceSessionReady: true })
    await vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toBe(true)
    store.setState({ workspaceSessionReady: false })
    const canceled = waitForRemoteWorkspaceSessionReady(
      { getState: store.getState },
      controller.signal
    )
    controller.abort()
    await expect(canceled).resolves.toBe(false)
    expect(subscribe).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives every concurrent waiter its own subscription and deadline', async () => {
    const { store, activeListeners } = readinessStore()
    const controllers = Array.from({ length: 64 }, () => new AbortController())
    const waits = controllers.map((controller) =>
      waitForRemoteWorkspaceSessionReady(store, controller.signal)
    )
    expect(activeListeners()).toBe(64)
    expect(vi.getTimerCount()).toBe(64)
    for (let index = 0; index < controllers.length; index += 2) {
      controllers[index]!.abort()
    }
    // Cancelling one waiter must release only its own resources.
    expect(activeListeners()).toBe(32)
    expect(vi.getTimerCount()).toBe(32)
    store.setState({ workspaceSessionReady: true })
    const results = await Promise.all(waits)
    expect(results.filter((ready) => ready)).toHaveLength(32)
    expect(results.filter((ready) => !ready)).toHaveLength(32)
    expect(activeListeners()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles once when a reentrant subscriber republishes during notification', async () => {
    const store = createStore(() => appState({ workspaceSessionReady: false }))
    let depth = 0
    let maxDepth = 0
    const offReentrant = store.subscribe((state) => {
      depth += 1
      maxDepth = Math.max(maxDepth, depth)
      if (state.workspaceSessionReady && depth < 3) {
        store.setState({ sortEpoch: depth })
      }
      depth -= 1
    })
    const originalSubscribe = store.subscribe
    let listeners = 0
    vi.spyOn(store, 'subscribe').mockImplementation((listener) => {
      listeners += 1
      const unsubscribe = originalSubscribe(listener)
      let disposed = false
      return () => {
        if (disposed) {
          return
        }
        disposed = true
        listeners -= 1
        unsubscribe()
      }
    })
    const settled = [vi.fn(), vi.fn()]
    const waits = settled.map((observe) => waitForRemoteWorkspaceSessionReady(store).then(observe))
    store.setState({ workspaceSessionReady: true })
    await Promise.all(waits)
    expect(maxDepth).toBeGreaterThan(1)
    for (const observe of settled) {
      expect(observe).toHaveBeenCalledTimes(1)
      expect(observe).toHaveBeenCalledWith(true)
    }
    expect(listeners).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    offReentrant()
  })

  it('stays settled and unsubscribed when readiness never arrives', async () => {
    const { store, activeListeners } = readinessStore()
    const resolved = vi.fn()
    const pending = waitForRemoteWorkspaceSessionReady(store).then(resolved)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(resolved).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(resolved).toHaveBeenCalledWith(false)
    await vi.advanceTimersByTimeAsync(600_000)
    store.setState({ workspaceSessionReady: true })
    await pending
    expect(resolved).toHaveBeenCalledTimes(1)
    expect(activeListeners()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['stale', 'stopped'] as const)(
    'starts no remote request when readiness is followed by a %s owner',
    async (outcome) => {
      const state = appState({ workspaceSessionReady: false })
      const getSnapshot = vi.fn(async () => null)
      const harness = createHarness(state, getSnapshot)
      const pending = harness.sync.syncAfterConnect(token())
      state.workspaceSessionReady = true
      harness.publishState()
      if (outcome === 'stale') {
        harness.makeStale()
      } else {
        harness.sync.stop()
      }
      await vi.advanceTimersByTimeAsync(100)
      await pending
      expect(getSnapshot).not.toHaveBeenCalled()
      expect(harness.activeStateListenerCount()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      harness.sync.stop()
    }
  )
})
