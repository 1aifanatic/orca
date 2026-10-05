import { isDeepStrictEqual } from 'node:util'
import type { TerminalTopologySlice } from '../../shared/terminal-topology-slice'
import type { WorkspaceSessionOwner } from './runtime-workspace-session-controller'
import {
  emptyTerminalTopologySlice,
  projectTerminalTopologySlice,
  type UnsequencedTerminalTopologySlice
} from './terminal-topology-projection'

type PublishedSlice = { publishSeq: number; snapshot: UnsequencedTerminalTopologySlice }

export type TerminalTopologySink = (slice: TerminalTopologySlice) => void

/**
 * Pushes a worktree's topology slice whenever a persisted write changes it by value.
 * Compares by value because some persistence writers edit session objects in place.
 */
export class TerminalTopologyPublisher {
  private sink: TerminalTopologySink | null = null
  private readonly published = new Map<string, PublishedSlice>()
  private lastSeq = 0
  private dirty = false
  private subscribed = false
  private failures = 0

  constructor(private readonly readOwners: () => Map<string, WorkspaceSessionOwner>) {}

  get failureCount(): number {
    return this.failures
  }

  /** Dormant until a reader subscribes, so writes cost nothing while no one listens. */
  setSink(sink: TerminalTopologySink | null): void {
    this.sink = sink
    this.dirty = false
    this.subscribed = false
    this.published.clear()
  }

  /** The current topology becomes the baseline unsent; the subscriber pulls it instead. */
  subscribe(): void {
    if (!this.sink || this.subscribed) {
      return
    }
    this.subscribed = true
    this.guard(() => this.reconcile(false))
  }

  markDirty(): void {
    if (!this.subscribed || this.dirty) {
      return
    }
    this.dirty = true
    // Coalesces a burst of writes in one task into one projection.
    queueMicrotask(() => this.flush())
  }

  flush(): void {
    if (!this.dirty) {
      return
    }
    this.dirty = false
    this.guard(() => this.reconcile(true))
  }

  /** A publishSeq whose push (or pull) includes every write made before this call. */
  settle(worktreeId?: string): number {
    this.flush()
    return (worktreeId ? this.published.get(worktreeId)?.publishSeq : undefined) ?? this.lastSeq
  }

  readSlices(): TerminalTopologySlice[] {
    if (!this.sink) {
      return [...this.readOwners()].map(([worktreeId, owner]) => ({
        ...projectTerminalTopologySlice(owner.session, owner.hostId, worktreeId),
        publishSeq: this.lastSeq
      }))
    }
    this.subscribe()
    this.flush()
    return [...this.published.values()].map(sequenced)
  }

  private reconcile(push: boolean): void {
    const owners = this.readOwners()
    const changed: UnsequencedTerminalTopologySlice[] = []
    for (const [worktreeId, owner] of owners) {
      const next = projectTerminalTopologySlice(owner.session, owner.hostId, worktreeId)
      if (!isDeepStrictEqual(this.published.get(worktreeId)?.snapshot, next)) {
        changed.push(structuredClone(next))
      }
    }
    const removed: UnsequencedTerminalTopologySlice[] = []
    for (const [worktreeId, { snapshot }] of this.published) {
      if (!owners.has(worktreeId)) {
        removed.push(emptyTerminalTopologySlice(snapshot.hostId, worktreeId, snapshot.revision))
      }
    }
    for (const snapshot of removed) {
      this.published.delete(snapshot.worktreeId)
      this.send({ publishSeq: ++this.lastSeq, snapshot })
    }
    for (const snapshot of changed) {
      const entry = { publishSeq: ++this.lastSeq, snapshot }
      this.published.set(snapshot.worktreeId, entry)
      if (push) {
        this.send(entry)
      }
    }
  }

  private send(entry: PublishedSlice): void {
    this.guard(() => this.sink?.(sequenced(entry)))
  }

  // A failed projection or push is counted and logged once; it never reaches the write.
  private guard(run: () => void): void {
    try {
      run()
    } catch (error) {
      this.failures += 1
      if (this.failures === 1) {
        console.warn('[terminal-topology] publish failed; persistence is unaffected:', error)
      }
    }
  }
}

function sequenced({ publishSeq, snapshot }: PublishedSlice): TerminalTopologySlice {
  return { ...snapshot, publishSeq }
}
