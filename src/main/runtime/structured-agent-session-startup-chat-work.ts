// The runtime's share of startup chat work: tab listings in flight, and the history restore a
// listing owes until it has started. The background copy of old chat files waits while any of it
// runs. Counted and cleared in the same code that does the work, so nothing here can strand.

export class StructuredAgentSessionStartupChatWork {
  private listings = 0
  private restoreStarting = false

  async trackListing(listing: () => Promise<void>): Promise<void> {
    this.listings += 1
    try {
      await listing()
    } finally {
      this.listings -= 1
    }
  }

  /** Starts the owed history restore on the next macrotask, and counts as work until it has: the
   *  host then reports the restore itself. */
  startRestoreSoon(start: () => void): void {
    this.restoreStarting = true
    setImmediate(() => {
      this.restoreStarting = false
      start()
    })
  }

  isActive(historyRestoreOwed: boolean): boolean {
    return this.listings > 0 || this.restoreStarting || historyRestoreOwed
  }
}
