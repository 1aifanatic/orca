type TeardownHost = {
  close(error?: Error): Promise<boolean>
  whenHandlersSettled(): Promise<void>
}

type TeardownExecutor = {
  close(): Promise<void>
}

type TeardownRouteSets = {
  close(error: Error): Promise<void>
}

export type BrowserClientHostCompositionTeardown = {
  host: TeardownHost
  executor: TeardownExecutor
  routeSets: TeardownRouteSets
  error: Error
  /** Receives the executor close that had to wait on unsettled handlers, so `whenClosed` can join it. */
  deferExecutorClose(close: Promise<void>): void
  reportCleanupError(error: Error): void
}

/**
 * Tears a composition's host, executor, and routes down, reporting every failure rather than the
 * first.
 *
 * Returns whether the host's handlers had already settled. When they had not, the executor close is
 * deferred behind them instead of racing them: closing an executor out from under a running handler
 * strands the page it was working on.
 */
export async function closeBrowserClientHostComposition(
  input: BrowserClientHostCompositionTeardown
): Promise<boolean> {
  const failures: unknown[] = []
  let handlersSettled = false
  try {
    handlersSettled = await input.host.close(input.error)
  } catch (hostError) {
    failures.push(hostError)
  }
  if (handlersSettled) {
    try {
      await input.executor.close()
    } catch (executorError) {
      failures.push(executorError)
    }
  } else {
    const deferred = input.host.whenHandlersSettled().then(() => input.executor.close())
    input.deferExecutorClose(deferred)
    void deferred.catch((cleanupError) =>
      input.reportCleanupError(asCompositionError(cleanupError))
    )
  }
  try {
    await input.routeSets.close(input.error)
  } catch (routeError) {
    failures.push(routeError)
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Browser client host composition cleanup failed')
  }
  return handlersSettled
}

export function asCompositionError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** How long a parked desktop keeps its live guests before freeing them; the tabs stay either way. */
const PARKED_GUEST_DISCARD_MS = 60 * 60 * 1000

type ReleasableGuests = {
  snapshotPageInventory(): readonly { browserPageId: string; pageHostGeneration: number }[]
  retirePage(browserPageId: string, pageHostGeneration: number): Promise<boolean>
}

/** Frees memory after a long absence only; it decides nothing about whether a page exists. */
export function scheduleParkedGuestDiscard(
  executor: ReleasableGuests,
  discardMs = PARKED_GUEST_DISCARD_MS
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(
    () => void releaseBrowserClientGuests(executor).catch(warnParkedCleanup),
    discardMs
  )
  timer.unref?.()
  return timer
}

/** Frees every live guest; the runtime recreates each page at its last URL when it can. */
export async function releaseBrowserClientGuests(executor: ReleasableGuests): Promise<void> {
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
  console.warn('[browser-client-host] parked cleanup failed:', asCompositionError(error).message)
}
