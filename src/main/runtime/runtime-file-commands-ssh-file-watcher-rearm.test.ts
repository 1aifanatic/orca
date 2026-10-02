import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IFilesystemProvider } from '../providers/types'
import { armSshFileExplorerWatchRearm } from './runtime-file-commands-ssh-file-watcher-rearm'

type WatchProvider = Pick<IFilesystemProvider, 'watch'>

const { getProvider, registrationListeners, rearms } = vi.hoisted(() => ({
  getProvider: vi.fn<(connectionId: string) => WatchProvider | undefined>(),
  registrationListeners: new Set<(connectionId: string) => void>(),
  rearms: new Map<string, Set<() => void>>()
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getProvider,
  onSshFilesystemProviderRegistered: (listener: (connectionId: string) => void) => {
    registrationListeners.add(listener)
    return () => registrationListeners.delete(listener)
  }
}))

vi.mock('./runtime-file-commands-mobile-file-list-limit', () => ({
  runtimeWatcherReleaseKey: (runtimeId: string, connectionId: string, rootPath: string) =>
    `${runtimeId}:${connectionId}:${rootPath}`,
  sshFileExplorerWatchRearms: rearms
}))

function registerProvider(provider: WatchProvider): void {
  getProvider.mockReturnValue(provider)
  for (const listener of registrationListeners) {
    listener('ssh-1')
  }
}

function pendingWatch() {
  let resolve: (unwatch: () => void) => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<() => void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { watch: vi.fn<IFilesystemProvider['watch']>(() => promise), resolve, reject }
}

describe('SSH file explorer watcher rearm', () => {
  let unsubscribe: (() => Promise<void>) | undefined

  beforeEach(() => {
    getProvider.mockReset()
    registrationListeners.clear()
    rearms.clear()
  })

  afterEach(async () => {
    await unsubscribe?.()
    unsubscribe = undefined
    expect(registrationListeners.size).toBe(0)
    expect(rearms.size).toBe(0)
  })

  function install(initialProvider: WatchProvider = { watch: vi.fn() }, initialUnwatch = vi.fn()) {
    if (!getProvider.getMockImplementation()) {
      getProvider.mockReturnValue(initialProvider)
    }
    const onEvents = vi.fn()
    const controller = new AbortController()
    const onTerminalError = vi.fn((_error: Error) => controller.abort())
    const rearm = armSshFileExplorerWatchRearm({
      runtimeId: 'runtime-1',
      connectionId: 'ssh-1',
      rootPath: '/remote/repo',
      callback: onEvents,
      onTerminalError,
      signal: controller.signal,
      initialUnwatch,
      initialProvider
    })
    unsubscribe = rearm.unsubscribe
    return { onEvents, onTerminalError, initialUnwatch, controller }
  }

  it('ignores a superseded setup failure and installs the current provider', async () => {
    const { onEvents, onTerminalError, controller } = install()
    const old = pendingWatch()
    registerProvider(old)
    await vi.waitFor(() => expect(old.watch).toHaveBeenCalledOnce())

    const currentUnwatch = vi.fn()
    const current = { watch: vi.fn(async () => currentUnwatch) }
    registerProvider(current)
    old.reject(new Error('previous transport disconnected'))

    await vi.waitFor(() => expect(current.watch).toHaveBeenCalledOnce())
    expect(onTerminalError).not.toHaveBeenCalled()
    expect(controller.signal.aborted).toBe(false)
    expect(onEvents).toHaveBeenCalledExactlyOnceWith([
      { kind: 'overflow', absolutePath: '/remote/repo' }
    ])
    await unsubscribe?.()
    expect(currentUnwatch).toHaveBeenCalledOnce()
  })

  it('replaces an initial watch whose provider changed before rearm was installed', async () => {
    const original = pendingWatch()
    const initialUnwatch = vi.fn()
    const initialSetup = original.watch('/remote/repo', vi.fn())
    const currentUnwatch = vi.fn()
    const current = { watch: vi.fn(async () => currentUnwatch) }
    registerProvider(current)
    original.resolve(initialUnwatch)
    await initialSetup
    const { onEvents, onTerminalError } = install(original, initialUnwatch)

    await vi.waitFor(() => expect(onEvents).toHaveBeenCalledOnce())
    expect(current.watch).toHaveBeenCalledOnce()
    expect(initialUnwatch).not.toHaveBeenCalled()
    expect(onTerminalError).not.toHaveBeenCalled()
    await unsubscribe?.()
    expect(currentUnwatch).toHaveBeenCalledOnce()
    expect(initialUnwatch).not.toHaveBeenCalled()
  })

  it('coalesces registrations that arrive before replacement setup starts', async () => {
    const { onEvents } = install()
    const old = { watch: vi.fn(async () => vi.fn()) }
    const current = { watch: vi.fn(async () => vi.fn()) }
    registerProvider(old)
    registerProvider(current)

    await vi.waitFor(() => expect(onEvents).toHaveBeenCalledOnce())
    expect(old.watch).not.toHaveBeenCalled()
    expect(current.watch).toHaveBeenCalledOnce()
  })

  it('closes a superseded successful setup without publishing its refresh', async () => {
    const { onEvents, onTerminalError } = install()
    const old = pendingWatch()
    registerProvider(old)
    await vi.waitFor(() => expect(old.watch).toHaveBeenCalledOnce())
    const currentUnwatch = vi.fn()
    const current = { watch: vi.fn(async () => currentUnwatch) }
    registerProvider(current)
    const obsoleteUnwatch = vi.fn()
    old.resolve(obsoleteUnwatch)

    await vi.waitFor(() => expect(current.watch).toHaveBeenCalledOnce())
    expect(obsoleteUnwatch).toHaveBeenCalledOnce()
    expect(onTerminalError).not.toHaveBeenCalled()
    expect(onEvents).toHaveBeenCalledOnce()
    await unsubscribe?.()
    expect(currentUnwatch).toHaveBeenCalledOnce()
  })

  it('reports a genuine current-provider setup failure', async () => {
    const { onTerminalError, onEvents } = install()
    const error = new Error('current host refused watch')
    registerProvider({
      watch: vi.fn(async () => {
        throw error
      })
    })

    await vi.waitFor(() => expect(onTerminalError).toHaveBeenCalledExactlyOnceWith(error))
    expect(onEvents).not.toHaveBeenCalled()
  })

  it('ignores late terminal callbacks from a superseded provider', async () => {
    const { onTerminalError, controller } = install()
    const old = pendingWatch()
    registerProvider(old)
    await vi.waitFor(() => expect(old.watch).toHaveBeenCalledOnce())
    const current = { watch: vi.fn(async () => vi.fn()) }
    registerProvider(current)
    old.watch.mock.calls[0]?.[2]?.onTerminalError?.(new Error('previous watcher stopped'))
    old.resolve(vi.fn())

    await vi.waitFor(() => expect(current.watch).toHaveBeenCalledOnce())
    expect(onTerminalError).not.toHaveBeenCalled()
    expect(controller.signal.aborted).toBe(false)
  })

  it('reports a terminal callback from the current provider', async () => {
    const { onTerminalError, onEvents } = install()
    const current = pendingWatch()
    registerProvider(current)
    await vi.waitFor(() => expect(current.watch).toHaveBeenCalledOnce())
    current.resolve(vi.fn())
    await vi.waitFor(() => expect(onEvents).toHaveBeenCalledOnce())
    const error = new Error('current watcher stopped')
    current.watch.mock.calls[0]?.[2]?.onTerminalError?.(error)

    expect(onTerminalError).toHaveBeenCalledExactlyOnceWith(error)
  })

  it('ignores late events from a superseded provider and delivers current events', async () => {
    const { onEvents } = install()
    const old = pendingWatch()
    registerProvider(old)
    await vi.waitFor(() => expect(old.watch).toHaveBeenCalledOnce())
    const current = pendingWatch()
    registerProvider(current)
    old.watch.mock.calls[0]?.[1]([{ kind: 'update', absolutePath: '/remote/repo/old.ts' }])
    old.resolve(vi.fn())
    await vi.waitFor(() => expect(current.watch).toHaveBeenCalledOnce())
    current.resolve(vi.fn())
    await vi.waitFor(() => expect(onEvents).toHaveBeenCalledOnce())
    const currentEvents = [{ kind: 'update' as const, absolutePath: '/remote/repo/current.ts' }]
    current.watch.mock.calls[0]?.[1](currentEvents)

    expect(onEvents).toHaveBeenCalledTimes(2)
    expect(onEvents).toHaveBeenLastCalledWith(currentEvents)
  })

  it('releases the previous subscriber when the same provider is registered again', async () => {
    const { onEvents } = install()
    const callbacks = new Set<Parameters<IFilesystemProvider['watch']>[1]>()
    const provider = {
      watch: vi.fn<IFilesystemProvider['watch']>(async (_root, callback) => {
        callbacks.add(callback)
        return () => {
          callbacks.delete(callback)
        }
      })
    }
    registerProvider(provider)
    await vi.waitFor(() => expect(onEvents).toHaveBeenCalledOnce())
    registerProvider(provider)
    await vi.waitFor(() => expect(onEvents).toHaveBeenCalledTimes(2))

    expect(callbacks.size).toBe(1)
    const events = [{ kind: 'update' as const, absolutePath: '/remote/repo/current.ts' }]
    for (const callback of callbacks) {
      callback(events)
    }
    expect(onEvents).toHaveBeenCalledTimes(3)
    expect(onEvents).toHaveBeenLastCalledWith(events)
    await unsubscribe?.()
    expect(callbacks.size).toBe(0)
  })

  it('does not report a setup failure after unsubscribe starts', async () => {
    const { onTerminalError, onEvents, initialUnwatch } = install()
    const pending = pendingWatch()
    registerProvider(pending)
    await vi.waitFor(() => expect(pending.watch).toHaveBeenCalledOnce())
    const closed = unsubscribe?.()
    pending.reject(new Error('setup canceled during shutdown'))

    await closed
    expect(initialUnwatch).toHaveBeenCalledOnce()
    expect(onTerminalError).not.toHaveBeenCalled()
    expect(onEvents).not.toHaveBeenCalled()
  })

  it('closes a replacement that finishes after unsubscribe starts', async () => {
    const { onTerminalError, onEvents } = install()
    const pending = pendingWatch()
    registerProvider(pending)
    await vi.waitFor(() => expect(pending.watch).toHaveBeenCalledOnce())
    const closed = unsubscribe?.()
    const lateUnwatch = vi.fn()
    pending.resolve(lateUnwatch)

    await closed
    expect(lateUnwatch).toHaveBeenCalledOnce()
    expect(onTerminalError).not.toHaveBeenCalled()
    expect(onEvents).not.toHaveBeenCalled()
  })
})
