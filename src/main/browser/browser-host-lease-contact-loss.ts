/**
 * A lease that ended because the runtime stopped answering within the reconnect grace, or answered
 * with a different lease. Neither says the pages are gone, so the owner parks rather than closes.
 */
export class BrowserHostLeaseContactLostError extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause })
    this.name = 'BrowserHostLeaseContactLostError'
  }
}

export function browserHostLeaseContactLost(error: unknown): BrowserHostLeaseContactLostError {
  return new BrowserHostLeaseContactLostError(
    error instanceof Error ? error : new Error(String(error))
  )
}

export function isBrowserHostLeaseContactLost(error: unknown): boolean {
  return error instanceof BrowserHostLeaseContactLostError
}
