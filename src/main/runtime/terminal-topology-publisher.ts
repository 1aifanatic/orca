import { isDeepStrictEqual } from 'node:util'
import type { TerminalTopologySlice } from '../../shared/terminal-topology-slice'
import type { TerminalSessionPartition } from '../persistence/terminal-topology/terminal-topology-membership'
import {
  emptyTerminalTopologySlice,
  projectTerminalTopologySlice,
  type UnsequencedTerminalTopologySlice
} from './terminal-topology-projection'

/** Each worktree's owning partition; null when it can't be resolved now (unverifiable, not absent). */
export type TerminalTopologyOwners = Map<string, TerminalSessionPartition | null>

type PublishedSlice = { publishSeq: number; snapshot: UnsequencedTerminalTopologySlice }

export type TerminalTopologySink = (slice: TerminalTopologySlice) => void

/**
 * Pushes a worktree's topology slice whenever a persisted write changes it by value.
 * Compares by value because some persistence writers edit session objects in place.
 */
export class TerminalTopologyPublisher {
  private readonly published = new Map<string, PublishedSlice>()
  private lastSeq = 0
  private dirty = false
  private failureLogged = false

  constructor(
    private readonly readOwners: () => TerminalTopologyOwners,
    private readonly sink: TerminalTopologySink
  ) {}

  markDirty(): void {
    if (this.dirty) {
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
    // A failed projection or push is logged once; it never reaches the write that notified it.
    try {
      this.reconcile()
    } catch (error) {
      if (!this.failureLogged) {
        this.failureLogged = true
        console.warn('[terminal-topology] publish failed; persistence is unaffected:', error)
      }
    }
  }

  /**
   * A publishSeq whose push includes every write made before this call; none for a worktree main
   * publishes no slice for, since no push will ever carry it.
   */
  settle(worktreeId?: string): number | undefined {
    this.flush()
    return worktreeId === undefined ? this.lastSeq : this.published.get(worktreeId)?.publishSeq
  }

  /** Every current slice, for a window that loaded after pushes it never saw. */
  snapshot(): TerminalTopologySlice[] {
    // Owners also follow the repo catalog, which changes without a session write.
    this.dirty = true
    this.flush()
    return [...this.published.values()].map(sequenced)
  }

  private reconcile(): void {
    const owners = this.readOwners()
    const changed: UnsequencedTerminalTopologySlice[] = []
    for (const [worktreeId, owner] of owners) {
      if (!owner) {
        continue // The last slice stands until the owner resolves.
      }
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
      this.sink(sequenced({ publishSeq: ++this.lastSeq, snapshot }))
    }
    for (const snapshot of changed) {
      const entry = { publishSeq: ++this.lastSeq, snapshot }
      this.published.set(snapshot.worktreeId, entry)
      this.sink(sequenced(entry))
    }
  }
}

function sequenced({ publishSeq, snapshot }: PublishedSlice): TerminalTopologySlice {
  return { ...snapshot, publishSeq }
}
