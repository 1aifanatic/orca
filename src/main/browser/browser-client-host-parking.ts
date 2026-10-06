import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'

/** How long a parked desktop keeps its live guests before freeing them; the tabs stay either way. */
export const PARKED_GUEST_DISCARD_MS = 60 * 60 * 1000

type ParkedLeaseOwner<Start> = {
  isClosed(): boolean
  /** Drops the current lease and routes, keeping the executor; frees every guest when asked to. */
  retireLease(input: Start, error: Error, releaseGuests: boolean): Promise<void>
  attach(input: Start): Promise<BrowserClientHostLeaseAuthority>
  /** Suspends routes and closes the lease, keeping every page. */
  suspend(error: Error): void
  releaseGuests(): Promise<void>
}

/**
 * The "runtime unreachable" state of a client-hosted browser composition, and the re-attach out
 * of it.
 *
 * Losing contact is never evidence the pages are gone, so the composition parks instead of tearing
 * down: guests stay, routes stay suspended (page traffic fails rather than leaving locally), and a
 * real event (connection ready, wake, online, the user opening the tab) asks for one re-attach.
 * Concurrent asks share that attempt. The only timer frees memory after a long absence; it decides
 * nothing about whether a page still exists.
 */
export class BrowserClientHostParking<Start> {
  private parked = false
  private discardTimer: ReturnType<typeof setTimeout> | null = null
  private attempt: {
    key: Start
    token: symbol
    promise: Promise<BrowserClientHostLeaseAuthority>
  } | null = null
  /** Whether the runtime last attached to can rekey guests this desktop kept through a fence. */
  private returningHostReclaim = false

  constructor(
    private input: Start,
    private readonly owner: ParkedLeaseOwner<Start>,
    private readonly discardAfterMs = PARKED_GUEST_DISCARD_MS
  ) {}

  get isParked(): boolean {
    return this.parked
  }

  noteAuthority(authority: BrowserClientHostLeaseAuthority): void {
    this.returningHostReclaim = authority.returningHostReclaimProtocolVersion === 1
  }

  park(error: Error): void {
    if (this.owner.isClosed()) {
      return
    }
    if (!this.parked) {
      console.warn('[browser-client-host] runtime unreachable; keeping pages until it returns:', {
        error: error.message
      })
      this.parked = true
      this.discardTimer = setTimeout(() => {
        this.discardTimer = null
        void this.owner.releaseGuests().catch(warnParkedCleanup)
      }, this.discardAfterMs)
      this.discardTimer.unref?.()
    }
    this.owner.suspend(error)
  }

  /** A newer runtime took over: re-attach under it, keeping every live guest. */
  replace(input: Start): Promise<BrowserClientHostLeaseAuthority> {
    this.input = input
    return this.coalesce(input, false)
  }

  /** One re-attach attempt, or null when not parked. */
  resume(): Promise<BrowserClientHostLeaseAuthority> | null {
    return this.parked ? this.coalesce(this.input, true) : null
  }

  dispose(): void {
    this.parked = false
    this.clearDiscardTimer()
  }

  /** One attempt per input at a time; an attempt for a newer input waits for the current one. */
  private coalesce(input: Start, resuming: boolean): Promise<BrowserClientHostLeaseAuthority> {
    const current = this.attempt
    if (current && current.key === input) {
      return current.promise
    }
    const settled = current ? current.promise.catch(() => undefined) : Promise.resolve()
    const token = Symbol('browser-client-host-attempt')
    // Cleared before callers resume, so a trigger right after a failed attempt starts a new one.
    const promise = settled
      .then(() => this.rehost(input, resuming))
      .finally(() => {
        if (this.attempt?.token === token) {
          this.attempt = null
        }
      })
    this.attempt = { key: input, token, promise }
    return promise
  }

  private async rehost(input: Start, resuming: boolean): Promise<BrowserClientHostLeaseAuthority> {
    this.assertOpen()
    // An older runtime cannot rekey a kept guest and would leave it placed nowhere; freeing it lets
    // that runtime's own recovery recreate the page at its last URL instead.
    const releaseGuests = resuming && !this.returningHostReclaim
    await this.owner.retireLease(
      input,
      new Error('Browser client host is re-attaching'),
      releaseGuests
    )
    this.assertOpen()
    try {
      const authority = await this.owner.attach(input)
      this.parked = false
      this.clearDiscardTimer()
      return authority
    } catch (error) {
      this.park(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  private assertOpen(): void {
    if (this.owner.isClosed()) {
      throw new Error('paired_runtime_browser_client_host_composition_closed')
    }
  }

  private clearDiscardTimer(): void {
    if (this.discardTimer) {
      clearTimeout(this.discardTimer)
      this.discardTimer = null
    }
  }
}

/** Frees every live guest; the runtime recreates each page at its last URL when it can. */
export async function releaseBrowserClientGuests(executor: {
  snapshotPageInventory(): readonly BrowserClientHostedPageInventory[]
  retirePage(browserPageId: string, pageHostGeneration: number): Promise<boolean>
}): Promise<void> {
  const results = await Promise.allSettled(
    executor
      .snapshotPageInventory()
      .map((page) => executor.retirePage(page.browserPageId, page.pageHostGeneration))
  )
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Browser client guest release failed')
  }
}

export function warnParkedCleanup(error: unknown): void {
  console.warn(
    '[browser-client-host] parked cleanup failed:',
    error instanceof Error ? error.message : String(error)
  )
}
