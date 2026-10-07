import {
  recordProfileStateWriterSlow,
  type ProfileStateWriterDiagnosticRequest,
  type ProfileStateWriterSlowPhase
} from './profile-state-writer-diagnostics'

export const PROFILE_STATE_WRITER_SLOW_WARNING_MS = 30_000

export type ProfileStateWriterSlowWarningOptions = {
  warningMs: number
  phase: ProfileStateWriterSlowPhase
  request: ProfileStateWriterDiagnosticRequest
  /** Monotonic milliseconds; tests replace it to model a stalled main loop. */
  now?: () => number
}

/** Elapsed time cannot prove failure; a slow operation only gets one breadcrumb. */
export function startProfileStateWriterSlowWarning({
  warningMs,
  phase,
  request,
  now = () => performance.now()
}: ProfileStateWriterSlowWarningOptions): () => void {
  const startedAt = now()
  const timer = setTimeout(() => {
    try {
      recordProfileStateWriterSlow({
        ...request,
        phase,
        elapsedMs: Math.max(0, Math.round(now() - startedAt))
      })
    } catch (error) {
      console.error('[persistence] Could not record slow profile state writer:', error)
    }
  }, warningMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}
