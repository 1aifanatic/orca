/** Release the waiter on close even when a stream reader or consumer has not settled. */
export function awaitOpenCodeHttp<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) {
      abort()
    }
  })
}

export function openCodeHttpDeadline(ms: number): { signal: AbortSignal; dispose: () => void } {
  if (!Number.isSafeInteger(ms) || ms < 1) {
    throw new RangeError('OpenCode deadline must be positive')
  }
  const cancellation = new AbortController()
  const timer = setTimeout(
    () => cancellation.abort(new Error('OpenCode HTTP deadline elapsed')),
    ms
  )
  timer.unref()
  return { signal: cancellation.signal, dispose: () => clearTimeout(timer) }
}
