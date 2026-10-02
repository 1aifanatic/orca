import { PluginDevWatcher } from './plugin-dev-watcher'

/** Starts and stops lifecycle maintenance as the feature flag and dev paths change. */
export class PluginServiceHousekeeping {
  private readonly devWatcher = new PluginDevWatcher()
  private reapTimer: ReturnType<typeof setInterval> | null = null
  private watchedPathsKey: string | null = null
  private retryRefresh: (() => void) | null = null

  sync(options: {
    enabled: boolean
    devPaths: readonly string[]
    reapIdle: () => void
    refresh: () => void
  }): void {
    if (!options.enabled) {
      this.stop()
      return
    }
    this.retryRefresh = options.refresh
    if (!this.reapTimer) {
      this.reapTimer = setInterval(() => {
        options.reapIdle()
        if (this.watchedPathsKey === null) {
          this.retryRefresh?.()
        }
      }, 60_000)
      this.reapTimer.unref?.()
    }
    const pathsKey = JSON.stringify(options.devPaths)
    if (pathsKey !== this.watchedPathsKey) {
      this.watchedPathsKey = pathsKey
      this.devWatcher.start(options.devPaths, options.refresh, () => {
        // Retry failed registration even when the configured paths are unchanged.
        this.watchedPathsKey = null
      })
    }
  }

  dispose(): void {
    this.stop()
  }

  private stop(): void {
    if (this.reapTimer) {
      clearInterval(this.reapTimer)
      this.reapTimer = null
    }
    this.devWatcher.dispose()
    this.watchedPathsKey = null
    this.retryRefresh = null
  }
}
