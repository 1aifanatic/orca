import { randomUUID } from 'node:crypto'

type Stamp = { revision: number; changedAtMs: number }

/**
 * Causal ordering for a headless host's tab presentation (view, owner, launch hint, layout): an
 * agent-exit retirement observed before the latest change is superseded. In memory only; a restart
 * starts a new epoch, so no published token from before it can match.
 */
export class HeadlessPresentationStamps {
  private readonly epoch = randomUUID().slice(0, 8)
  private readonly stamps = new Map<string, Stamp>()

  private key(worktreeId: string, tabId: string): string {
    return `${worktreeId}\0${tabId}`
  }

  bump(worktreeId: string, tabId: string, nowMs = Date.now()): void {
    const key = this.key(worktreeId, tabId)
    const current = this.stamps.get(key)
    this.stamps.set(key, {
      revision: (current?.revision ?? 0) + 1,
      changedAtMs: Math.max(nowMs, current?.changedAtMs ?? 0)
    })
  }

  read(worktreeId: string, tabId: string): Stamp {
    return this.stamps.get(this.key(worktreeId, tabId)) ?? { revision: 0, changedAtMs: 0 }
  }

  token(worktreeId: string, tabId: string): string {
    return `${this.epoch}.${this.read(worktreeId, tabId).revision}`
  }

  forgetWorktree(worktreeId: string): void {
    for (const key of this.stamps.keys()) {
      if (key.startsWith(`${worktreeId}\0`)) {
        this.stamps.delete(key)
      }
    }
  }
}
