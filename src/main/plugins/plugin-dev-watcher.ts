import { realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import {
  subscribeViaWatcherProcess,
  type WatcherProcessSubscribeOptions,
  type WatcherProcessSubscription
} from '../ipc/parcel-watcher-process'
import { resolveWatcherRootPaths } from '../ipc/watcher-event-root-path-rewrite'

// Deleted roots can reject unsubscribe after the native stream has stopped.
function releaseSubscription(subscription: WatcherProcessSubscription): void {
  void subscription.unsubscribe().catch(() => undefined)
}

/** Owns debounced manifest/panel refresh watchers for mutable dev plugins. */
export class PluginDevWatcher {
  private readonly subscriptions: WatcherProcessSubscription[] = []
  private readonly physicalRoots = new Map<string, string>()
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private generation = 0

  constructor(private readonly subscribePath = subscribeViaWatcherProcess) {}

  start(devPaths: readonly string[], refresh: () => void, onWatcherError?: () => void): void {
    this.stopSubscriptions()
    const requestedRoots = new Set(devPaths.map((path) => resolve(path)))
    for (const path of this.physicalRoots.keys()) {
      if (!requestedRoots.has(path)) {
        this.physicalRoots.delete(path)
      }
    }
    const parentNames = new Map<string, Set<string>>()
    for (const requestedRoot of requestedRoots) {
      const { watchRoot } = resolveWatcherRootPaths(requestedRoot, {
        realpath: (candidate) => {
          const physicalRoot = realpathSync.native(candidate)
          this.physicalRoots.set(requestedRoot, physicalRoot)
          return physicalRoot
        }
      })
      // A dangling symlink still needs its last physical parent watched.
      const physicalRoot = this.physicalRoots.get(requestedRoot) ?? watchRoot
      for (const root of new Set([requestedRoot, physicalRoot])) {
        const { watchRoot: parent } = resolveWatcherRootPaths(dirname(root))
        const names = parentNames.get(parent) ?? new Set<string>()
        names.add(basename(root))
        parentNames.set(parent, names)
      }
      this.subscribe(
        requestedRoot,
        process.platform === 'win32' ? { backend: 'windows' } : {},
        false,
        refresh,
        onWatcherError
      )
    }
    for (const [parent, names] of parentNames) {
      this.subscribe(
        parent,
        { mode: 'shallow', include: [...names] },
        true,
        refresh,
        onWatcherError
      )
    }
  }

  dispose(): void {
    this.stopSubscriptions()
    this.physicalRoots.clear()
  }

  private stopSubscriptions(): void {
    this.generation += 1
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    for (const subscription of this.subscriptions.splice(0)) {
      releaseSubscription(subscription)
    }
  }

  private subscribe(
    path: string,
    options: WatcherProcessSubscribeOptions,
    parent: boolean,
    refresh: () => void,
    onWatcherError?: () => void
  ): void {
    const generation = this.generation
    let subscription: WatcherProcessSubscription | null = null
    let closed = false
    const isActive = (): boolean => generation === this.generation && !closed
    const requestRetry = (): void => {
      if (isActive()) {
        onWatcherError?.()
        this.scheduleRefresh(refresh)
      }
    }
    const fail = (): void => {
      if (!isActive()) {
        return
      }
      requestRetry()
      closed = true
      if (subscription) {
        this.removeSubscription(subscription)
        releaseSubscription(subscription)
      }
    }
    void this.subscribePath(
      path,
      (error, events) => {
        if (!isActive()) {
          return
        }
        if (error || events.some((event) => event.type === 'delete' && event.path === path)) {
          fail()
        } else if (parent) {
          // Root replacement stops recursive watching without reporting an error.
          requestRetry()
        } else {
          this.scheduleRefresh(refresh)
        }
      },
      options,
      { onInterruption: requestRetry, onOverflow: requestRetry, onTerminalError: fail }
    )
      .then((created) => {
        subscription = created
        if (!isActive()) {
          releaseSubscription(created)
          return
        }
        this.subscriptions.push(created)
      })
      .catch(() => {
        if (isActive()) {
          closed = true
          // The parent watch or maintenance interval retries missing roots.
          onWatcherError?.()
        }
      })
  }

  private removeSubscription(subscription: WatcherProcessSubscription): void {
    const index = this.subscriptions.indexOf(subscription)
    if (index !== -1) {
      this.subscriptions.splice(index, 1)
    }
  }

  private scheduleRefresh(refresh: () => void): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      refresh()
    }, 300)
  }
}
