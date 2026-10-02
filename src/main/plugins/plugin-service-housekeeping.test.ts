import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginDevWatcher } from './plugin-dev-watcher'
import { PluginServiceHousekeeping } from './plugin-service-housekeeping'

vi.mock('./plugin-dev-watcher', () => ({
  PluginDevWatcher: vi.fn(function () {
    return { start: vi.fn(), dispose: vi.fn() }
  })
}))

let housekeeping: PluginServiceHousekeeping

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  housekeeping = new PluginServiceHousekeeping()
})

afterEach(() => {
  housekeeping.dispose()
  vi.useRealTimers()
})

function watcher(): PluginDevWatcher {
  const instance = vi.mocked(PluginDevWatcher).mock.results[0]?.value
  if (!(instance instanceof Object) || !('start' in instance) || !('dispose' in instance)) {
    throw new Error('Plugin watcher mock missing')
  }
  return instance
}

function sync() {
  const reapIdle = vi.fn<() => void>()
  const refresh = vi.fn<() => void>()
  housekeeping.sync({ enabled: true, devPaths: ['plugin'], reapIdle, refresh })
  return { reapIdle, refresh }
}

function failRegistration(): void {
  const onWatcherError = vi.mocked(watcher().start).mock.calls[0]?.[2]
  if (!onWatcherError) {
    throw new Error('Registration failure callback missing')
  }
  onWatcherError()
}

describe('PluginServiceHousekeeping', () => {
  it('reaps healthy workers without polling or restarting plugin watchers', () => {
    const { reapIdle, refresh } = sync()
    vi.advanceTimersByTime(180_000)
    expect(reapIdle).toHaveBeenCalledTimes(3)
    expect(refresh).not.toHaveBeenCalled()
    expect(watcher().start).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('retries failed registration using the existing maintenance interval', () => {
    const { reapIdle, refresh } = sync()
    failRegistration()
    vi.advanceTimersByTime(59_999)
    expect(refresh).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reapIdle).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    housekeeping.sync({ enabled: true, devPaths: ['plugin'], reapIdle, refresh })
    expect(watcher().start).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(60_000)
    expect(refresh).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('retains a synchronous startup failure for the next bounded retry', () => {
    vi.mocked(watcher().start).mockImplementation((_paths, _refresh, onWatcherError) => {
      onWatcherError?.()
    })
    const { refresh } = sync()
    vi.advanceTimersByTime(60_000)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('stops retries and releases subscriptions when disabled or disposed', () => {
    const { reapIdle, refresh } = sync()
    failRegistration()
    housekeeping.sync({ enabled: false, devPaths: ['plugin'], reapIdle, refresh })
    vi.advanceTimersByTime(120_000)
    expect(reapIdle).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    sync()
    failRegistration()
    housekeeping.dispose()
    vi.advanceTimersByTime(120_000)
    expect(refresh).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
