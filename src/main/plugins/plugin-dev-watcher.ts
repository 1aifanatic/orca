import { realpathSync, statSync, type Stats } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
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

function addPluginRootParent(parentNames: Map<string, Set<string>>, root: string): void {
  const { watchRoot: parent } = resolveWatcherRootPaths(dirname(root))
  const names = parentNames.get(parent) ?? new Set<string>()
  names.add(basename(root))
  parentNames.set(parent, names)
}

type PluginRootBinding = { physicalRoot: string; identity: string }

function pluginRootBinding(physicalRoot: string, entry: Stats): PluginRootBinding | null {
  return entry.isDirectory() ? { physicalRoot, identity: `${entry.dev}:${entry.ino}` } : null
}

function readPluginRootBindingSync(physicalRoot: string): PluginRootBinding | null {
  try {
    return pluginRootBinding(physicalRoot, statSync(physicalRoot))
  } catch {
    return null
  }
}

async function readPluginRootBinding(requestedRoot: string): Promise<PluginRootBinding | null> {
  try {
    const physicalRoot = await realpath(requestedRoot)
    return pluginRootBinding(physicalRoot, await stat(physicalRoot))
  } catch {
    return null
  }
}

/** Owns debounced manifest/panel refresh watchers for mutable dev plugins. */
export class PluginDevWatcher {
  private readonly subscriptions: WatcherProcessSubscription[] = []
  private readonly physicalRoots = new Map<string, string>()
  private readonly rootBindings = new Map<string, PluginRootBinding | null>()
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private generation = 0

  constructor(private readonly subscribePath = subscribeViaWatcherProcess) {}

  start(
    devPaths: readonly string[],
    refresh: () => void,
    onWatcherError?: (retry?: boolean) => void
  ): void {
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
      this.rootBindings.set(requestedRoot, readPluginRootBindingSync(watchRoot))
      // macOS parent streams are recursive; Windows child edits also report parent names.
      if (process.platform !== 'darwin' && process.platform !== 'win32') {
        // A dangling symlink still needs its last physical parent watched.
        const physicalRoot = this.physicalRoots.get(requestedRoot) ?? watchRoot
        for (const root of new Set([requestedRoot, physicalRoot])) {
          addPluginRootParent(parentNames, root)
        }
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

  async checkRootBindings(): Promise<boolean | null> {
    const generation = this.generation
    const nextBindings = await Promise.all(
      [...this.rootBindings.keys()].map(async (root) => ({
        root,
        binding: await readPluginRootBinding(root)
      }))
    )
    if (generation !== this.generation) {
      return null
    }
    let changed = false
    for (const { root, binding } of nextBindings) {
      const previous = this.rootBindings.get(root)
      if (
        previous?.physicalRoot !== binding?.physicalRoot ||
        previous?.identity !== binding?.identity
      ) {
        this.rootBindings.set(root, binding)
        changed = true
      }
    }
    return changed
  }

  private stopSubscriptions(): void {
    this.generation += 1
    this.rootBindings.clear()
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
    onWatcherError?: (retry?: boolean) => void
  ): void {
    const generation = this.generation
    const retrySetupFailure = parent
      ? readPluginRootBindingSync(path) !== null
      : !!this.rootBindings.get(path)
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
          // Missing roots recover through binding checks instead of refresh loops.
          onWatcherError?.(retrySetupFailure)
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
