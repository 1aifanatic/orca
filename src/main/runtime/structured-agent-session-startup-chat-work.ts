// The runtime's share of startup chat work: tab listings in flight, and the history restore a
// listing owes until it has started. The background copy of old chat files waits while any of it
// runs. Counted and cleared in the same code that does the work, so nothing here can strand.

export class StructuredAgentSessionStartupChatWork {
  private listings = 0
  /** The history restore a tab restore owes, until a caller that answered with its list starts it. */
  private owedRestore: (() => void) | null = null
  private restoreStarting = false

  async trackListing(listing: () => Promise<void>): Promise<void> {
    this.listings += 1
    try {
      await listing()
    } finally {
      this.listings -= 1
    }
  }

  oweRestore(restore: (() => void) | null): void {
    this.owedRestore = restore
  }

  /** Starts the owed history restore, once, on the next macrotask, and counts as work until it has:
   *  the host then reports the restore itself. */
  startOwedRestoreSoon(): void {
    const start = this.owedRestore
    this.owedRestore = null
    if (!start) {
      return
    }
    this.restoreStarting = true
    setImmediate(() => {
      this.restoreStarting = false
      start()
    })
  }

  isActive = (): boolean => this.listings > 0 || this.restoreStarting || this.owedRestore !== null
}
