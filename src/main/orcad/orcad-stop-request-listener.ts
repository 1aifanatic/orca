/**
 * Watching for stop requests addressed to this orcad.
 *
 * Two listeners share one shutdown: the plain slot request (`.orcad-stop-request` beside
 * `orcad.js`, consumed by unlinking it) and the instance-bound managed request in the data
 * root, which is validated and kept as evidence until the completion command proves exit.
 */
import { unlinkSync, watch, type FSWatcher } from 'node:fs'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { basename, dirname, join } from 'node:path'
import {
  ORCAD_STOP_REQUEST_FILENAME,
  type OrcadManagedStopContext,
  type OrcadManagedStopRequest
} from '../../shared/orcad-stop-request'
import {
  orcadManagedStopRequestPath,
  validateOrcadManagedStopRequest
} from './orcad-managed-stop-request'
import {
  claimOrcadManagedStopDecision,
  readOrcadManagedStopDecision
} from './orcad-managed-stop-decision'
import { withdrawOrcadManagedStopRequest } from './orcad-managed-stop-cancellation'
import { hasErrorCode } from '../daemon/daemon-process-inspection'
import { orcadManagedStopIsUserRequested } from './orcad-managed-stop-intent'

export type OrcadStopRequestListener = { close(): void }

const DEFAULT_POLL_INTERVAL_MS = 1_000

/** `consume` returns the request that should stop orcad, or null; a missing file throws ENOENT. */
function listenForRequest<T>(
  requestPath: string,
  consume: (path: string) => T | null,
  onRequest: (request: T) => void,
  pollIntervalMs: number
): OrcadStopRequestListener {
  let closed = false
  let lastFailure: string | null = null
  const check = (): void => {
    if (closed) {
      return
    }
    let request: T | null
    try {
      request = consume(requestPath)
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        // Polling retries every interval; report each distinct refusal once.
        const failure = error instanceof Error ? error.message : String(error)
        if (failure !== lastFailure) {
          lastFailure = failure
          console.error(`[orcad] refused stop request at ${requestPath}:`, error)
        }
      }
      return
    }
    if (request === null) {
      return
    }
    closed = true
    stop()
    onRequest(request)
  }
  let watcher: FSWatcher | null = null
  try {
    watcher = watch(dirname(requestPath), (_event, changed) => {
      if (!changed || basename(String(changed)) === basename(requestPath)) {
        check()
      }
    })
    watcher.on('error', (error) => console.error('[orcad] stop-request watcher failed:', error))
    watcher.unref()
  } catch (error) {
    // The poll below still delivers requests; a watcher only makes them prompt.
    console.error('[orcad] stop-request watcher could not start:', error)
  }
  const poll = setInterval(check, pollIntervalMs)
  poll.unref()
  const stop = (): void => {
    watcher?.close()
    clearInterval(poll)
  }
  // Covers a request written before this listener was installed.
  check()
  return {
    close: () => {
      closed = true
      stop()
    }
  }
}

export function installOrcadStopRequestListeners(
  onRequest: () => void,
  options: {
    installRoot: string
    managedStop?: OrcadManagedStopContext
    /** Commits only after a host observation proves no work, then closes chat admission. */
    admitAutomaticStop: (commit: () => boolean) => boolean
    /** Runs once for a validated managed request before the stop; it cannot prevent it. */
    beforeManagedStop?: (request: OrcadManagedStopRequest) => Promise<void>
    pollIntervalMs?: number
  }
): OrcadStopRequestListener {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  // Declared first: a listener's initial check can consume a request and close before returning.
  const listeners: OrcadStopRequestListener[] = []
  const close = (): void => {
    for (const listener of listeners) {
      listener.close()
    }
  }
  listeners.push(
    listenForRequest(
      join(options.installRoot, ORCAD_STOP_REQUEST_FILENAME),
      (path) => {
        const user =
          readNodeFileSyncWithinLimit(path, 1024).buffer.toString('utf8').trim() ===
          '{"intent":"user"}'
        const consume = (): boolean => {
          unlinkSync(path)
          return true
        }
        return user ? consume() : options.admitAutomaticStop(consume) ? true : null
      },
      () => onRequest(),
      pollIntervalMs
    )
  )
  const managedStop = options.managedStop
  if (managedStop) {
    const prepare = options.beforeManagedStop ?? (async () => {})
    listeners.push(
      listenForRequest(
        orcadManagedStopRequestPath(managedStop.instance),
        (path) => {
          const request = validateOrcadManagedStopRequest(managedStop, path)
          if (readOrcadManagedStopDecision(request) === 'canceled') {
            withdrawOrcadManagedStopRequest(request)
            throw new Error('orcad_managed_stop_canceled')
          }
          const commit = (): boolean => {
            if (claimOrcadManagedStopDecision(request, 'dispatched') === 'canceled') {
              withdrawOrcadManagedStopRequest(request)
              throw new Error('orcad_managed_stop_canceled')
            }
            return true
          }
          const admitted = orcadManagedStopIsUserRequested(request)
            ? commit()
            : options.admitAutomaticStop(commit)
          return admitted ? request : null
        },
        (request) => {
          close()
          // Preparation is best effort: whatever it reports, the stop proceeds.
          void prepare(request)
            .catch((error: unknown) =>
              console.error('[orcad] managed stop preparation failed:', error)
            )
            .finally(onRequest)
        },
        pollIntervalMs
      )
    )
  }
  return { close }
}
