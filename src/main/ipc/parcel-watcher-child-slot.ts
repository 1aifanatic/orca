import type { ChildProcess } from 'node:child_process'
import { removeWatcherCanaryDirectory } from './parcel-watcher-canary-directory'

/** The supervisor's one watcher child: the live one, the one being terminated, and its canary. */
export class WatcherChildSlot {
  child: ChildProcess | null = null
  terminating: ChildProcess | null = null
  canaryDir: string | null = null

  /** The canary belongs to the child it was launched with, so it goes when that child does. */
  removeCanary(): void {
    this.canaryDir = removeWatcherCanaryDirectory(this.canaryDir)
  }

  /** Marks `proc` as the child being terminated; a later launch waits until it is settled. */
  beginTermination(proc: ChildProcess): void {
    this.terminating = proc
    this.removeCanary()
  }
}
