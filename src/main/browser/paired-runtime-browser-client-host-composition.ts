import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import { isBrowserClientHostAuthorityReplaced } from './browser-client-host-authority-replacement'
import { browserHostAnswer, isBrowserHostRefusal } from './browser-host-admission-recovery'
import {
  asCompositionError,
  closeBrowserClientHostComposition,
  releaseBrowserClientGuests,
  scheduleParkedGuestDiscard,
  warnParkedCleanup
} from './paired-runtime-browser-client-host-teardown'
import { PairedRuntimeBrowserClientHostRouteSets } from './paired-runtime-browser-client-host-route-sets'
import type {
  BrowserClientHostAuthorityTransitionInput,
  ComposedClientHost,
  ComposedPageExecutor,
  PairedRuntimeBrowserClientHostCompositionOptions
} from './paired-runtime-browser-client-host-composition-contract'

export class PairedRuntimeBrowserClientHostComposition<
  Start extends BrowserClientHostAuthorityTransitionInput
> {
  private readonly executor: ComposedPageExecutor
  private host: ComposedClientHost
  private readonly routeSets: PairedRuntimeBrowserClientHostRouteSets<Start>
  private startPromise: Promise<BrowserClientHostLeaseAuthority> | null = null
  private closePromise: Promise<boolean> | null = null
  private deferredExecutorClose: Promise<void> | null = null
  private hostGeneration = 0
  private closed = false
  private errorReported = false
  private inventoryRefreshPromise: Promise<void> | null = null
  private input: Start
  private lastAuthority: BrowserClientHostLeaseAuthority | null = null
  /** Set while the runtime is unreachable: pages and suspended routes are kept for its return. */
  private parked: { discardTimer: ReturnType<typeof setTimeout> | null } | null = null

  constructor(private readonly options: PairedRuntimeBrowserClientHostCompositionOptions<Start>) {
    this.input = options.initialInput
    this.routeSets = new PairedRuntimeBrowserClientHostRouteSets({
      createRoutes: options.createRoutes,
      onRecoveryError: (error) => this.handleHostError(error),
      onCleanupError: (error) => this.handleHostError(error)
    })
    this.executor = options.createExecutor(options.initialInput, {
      retainNetworkRoute: (key, signal) => this.routeSets.retain(key, signal),
      onPageUnavailable: () => this.requestPageInventoryRefresh()
    })
    this.host = this.createHost(options.initialInput, false)
  }

  start(): Promise<BrowserClientHostLeaseAuthority> {
    if (this.closed) {
      return Promise.reject(new Error('paired_runtime_browser_client_host_composition_closed'))
    }
    this.startPromise ??= this.host.start()
    return this.startPromise
  }

  get isParked(): boolean {
    return this.parked !== null
  }

  replaceAuthority(input: Start): Promise<BrowserClientHostLeaseAuthority> {
    if (this.closed) {
      return Promise.reject(new Error('paired_runtime_browser_client_host_composition_closed'))
    }
    this.input = input
    this.startPromise = this.reattach(input, false)
    return this.startPromise
  }

  /** One re-attach for a parked composition; a live one answers with its current lease. */
  resume(): Promise<BrowserClientHostLeaseAuthority> {
    if (this.closed || !this.parked) {
      return this.start()
    }
    this.startPromise = this.reattach(this.input, true)
    return this.startPromise
  }

  /** Holds the pages for the runtime's return; only `close` gives them up. */
  park(error: Error): void {
    if (this.closed) {
      return
    }
    if (!this.parked) {
      console.warn('[browser-client-host] runtime unreachable; keeping pages until it returns:', {
        error: error.message
      })
    }
    this.parked ??= { discardTimer: null }
    this.parked.discardTimer ??= scheduleParkedGuestDiscard(
      this.executor,
      this.options.parkedGuestDiscardMs
    )
    // The dead lease's late callbacks must not reach the kept guests.
    this.hostGeneration += 1
    this.routeSets.fence(error)
    // Why not reportCleanupError: the owner treats any report as fatal and retires.
    void this.host.close(error).catch(warnParkedCleanup)
  }

  async retirePage(browserPageId: string, pageHostGeneration: number): Promise<boolean> {
    if (this.closed) {
      throw new Error('paired_runtime_browser_client_host_composition_closed')
    }
    if (!(await this.host.retirePage(browserPageId, pageHostGeneration))) {
      return false
    }
    if (
      !(await this.executor.retirePage(browserPageId, pageHostGeneration)) &&
      this.executor.hasUnresolvedPage(browserPageId, pageHostGeneration)
    ) {
      throw new Error('browser_client_page_retirement_cleanup_pending')
    }
    if (!this.host.forgetPage(browserPageId, pageHostGeneration)) {
      throw new Error('browser_client_page_retirement_forget_failed')
    }
    return true
  }

  close(error = new Error('Browser client host composition is closed')): Promise<boolean> {
    if (!this.closed) {
      this.closed = true
      this.clearGuestDiscard()
      this.parked = null
      this.hostGeneration += 1
      try {
        this.options.onClosing?.()
      } catch (closingError) {
        this.reportCleanupError(asCompositionError(closingError))
      }
      this.fenceTerminalAuthority(error)
    }
    this.closePromise ??= this.closeComposition(error)
    return this.closePromise
  }

  async whenClosed(): Promise<void> {
    if (!this.closePromise) {
      throw new Error('paired_runtime_browser_client_host_composition_open')
    }
    await this.closePromise
    await this.deferredExecutorClose
  }

  private createHost(input: Start, requiresReconciliation: boolean): ComposedClientHost {
    const generation = ++this.hostGeneration
    let publishedInventory: readonly BrowserClientHostedPageInventory[] | null = null
    return this.options.createHost(input, {
      handler: (event, signal) => this.handleCommand(generation, event, signal),
      getPageInventory: () => {
        if (this.hostGeneration !== generation) {
          return []
        }
        publishedInventory = this.executor.snapshotPageInventory()
        return publishedInventory
      },
      onAuthority: (authority) => {
        if (this.hostGeneration === generation) {
          if (
            requiresReconciliation &&
            publishedInventory?.length &&
            authority.pageReconciliationProtocolVersion !== 1
          ) {
            // Read from the runtime's own ready answer, so it is as final as a refusal.
            throw browserHostAnswer(new Error('browser_client_page_reconciliation_unsupported'))
          }
          this.routeSets.activate(input, authority)
          this.lastAuthority = authority
        }
      },
      onTransportLost: (error) => {
        if (this.hostGeneration === generation) {
          this.routeSets.suspend(error)
        }
      },
      onReconnected: (authority) => {
        if (this.hostGeneration === generation) {
          this.routeSets.reconnect(authority)
        }
      },
      onError: (error) => {
        if (this.hostGeneration !== generation) {
          return
        }
        this.parkOrFail(error)
      }
    })
  }

  /**
   * Swaps the lease for a fresh one under `input`, keeping the executor so its guests survive; the
   * attach inventory is what lets the runtime rekey them in place.
   */
  private async reattach(
    input: Start,
    sameRuntime: boolean
  ): Promise<BrowserClientHostLeaseAuthority> {
    this.clearGuestDiscard()
    const error = new Error('Browser client host is re-attaching')
    this.hostGeneration += 1
    this.routeSets.retireCurrent(error)
    this.executor.beginAuthorityTransition()
    try {
      const previousHost = this.host
      if (!(await previousHost.close(error).catch(() => false))) {
        await previousHost.whenHandlersSettled()
      }
    } finally {
      this.executor.completeAuthorityTransition(input)
    }
    if (this.closed) {
      throw new Error('paired_runtime_browser_client_host_composition_closed')
    }
    try {
      this.host = this.createHost(input, true)
      const authority = await this.host.start()
      // An older runtime cannot rekey a kept guest and leaves it placed nowhere. Only its answer
      // says so; freeing the guests and republishing lets its recovery reload them at their URL.
      if (sameRuntime && authority.returningHostReclaimProtocolVersion !== 1) {
        await releaseBrowserClientGuests(this.executor)
        await this.host.refreshPageInventory()
      }
      this.parked = null
      return authority
    } catch (attachError) {
      this.parkOrFail(asCompositionError(attachError))
      throw attachError
    }
  }

  /** Only the runtime's own refusal is final; anything else may be lost contact and is waited out. */
  private parkOrFail(error: Error): void {
    if (
      !this.closed &&
      this.lastAuthority !== null &&
      (!isBrowserHostRefusal(error) || isBrowserClientHostAuthorityReplaced(error))
    ) {
      this.park(error)
      return
    }
    this.handleHostError(error)
  }

  private clearGuestDiscard(): void {
    if (this.parked?.discardTimer) {
      clearTimeout(this.parked.discardTimer)
      this.parked.discardTimer = null
    }
  }

  private async handleCommand(
    generation: number,
    event: BrowserClientHostCommandEvent,
    signal: AbortSignal
  ): Promise<BrowserClientHostCommandResult> {
    if (this.hostGeneration !== generation) {
      throw new Error('browser_client_host_command_aborted')
    }
    await this.routeSets.waitForRecovery(signal)
    if (this.closed || signal.aborted || this.hostGeneration !== generation) {
      throw new Error('browser_client_host_command_aborted')
    }
    return this.executor.handle(event, signal)
  }

  private requestPageInventoryRefresh(): void {
    // A parked composition has no lease to refresh; its next attach carries a fresh inventory.
    if (this.closed || this.parked || this.inventoryRefreshPromise) {
      return
    }
    const refresh = this.host.refreshPageInventory()
    this.inventoryRefreshPromise = refresh
    void refresh
      .catch((error) => this.handleHostError(asCompositionError(error)))
      .finally(() => {
        if (this.inventoryRefreshPromise === refresh) {
          this.inventoryRefreshPromise = null
        }
      })
  }

  private fenceTerminalAuthority(error: Error): void {
    this.routeSets.fence(error)
    try {
      this.executor.fenceNavigation()
    } catch (navigationError) {
      this.reportCleanupError(asCompositionError(navigationError))
    }
  }

  private closeComposition(error: Error): Promise<boolean> {
    return closeBrowserClientHostComposition({
      host: this.host,
      executor: this.executor,
      routeSets: this.routeSets,
      error,
      deferExecutorClose: (close) => {
        this.deferredExecutorClose = close
      },
      reportCleanupError: (cleanupError) => this.reportCleanupError(cleanupError)
    })
  }

  private handleHostError(error: Error): void {
    void this.close(error).catch((closeError) => this.reportError(asCompositionError(closeError)))
    this.reportError(error)
  }

  private reportError(error: Error): void {
    if (this.errorReported) {
      return
    }
    this.errorReported = true
    try {
      this.options.onError?.(error)
    } catch {}
  }

  private reportCleanupError(error: Error): void {
    try {
      this.options.onError?.(error)
    } catch {}
  }
}
