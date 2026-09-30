import type { DurablePushStore } from './durable-push-store.js'
import type { DurablePushWorker } from './durable-push-worker.js'
import type { PushHostChallengeStore } from './host-challenge-store.js'
import type { PushHostSessionStore } from './host-session-store.js'
import { startPushBackground } from './push-background.js'

export type PruneScheduler = 'interval' | 'chained' | 'none'
type BackgroundRuntime = {
  challenges: PushHostChallengeStore
  sessions: PushHostSessionStore
  deliveryStore: DurablePushStore
  worker: DurablePushWorker
}

// The scheduler as deployed at b0135903633: a repeating timer that starts a sweep every interval
// whether or not the previous one finished.
function startRepeatingPruneBackground(runtime: BackgroundRuntime): () => Promise<void> {
  const repeat = (label: string, run: () => Promise<unknown>, intervalMs: number) => {
    const timer = setInterval(() => {
      void run().catch((error: unknown) => {
        console.warn(
          JSON.stringify({
            event: 'orca_push_prune_failed',
            target: label,
            error: error instanceof Error ? error.name : 'unknown'
          })
        )
      })
    }, intervalMs)
    timer.unref()
    return timer
  }
  const timers = [
    repeat('challenges', () => runtime.challenges.pruneExpired(), 60_000),
    repeat('sessions', () => runtime.sessions.pruneExpired(), 10 * 60_000),
    repeat('deliveries', () => runtime.deliveryStore.prune(), 60_000)
  ]
  runtime.worker.start()
  return async () => {
    for (const timer of timers) clearInterval(timer)
    await runtime.worker.stop()
  }
}

export function startLoadBackground(
  scheduler: PruneScheduler,
  runtime: BackgroundRuntime
): () => Promise<void> {
  if (scheduler === 'chained') return startPushBackground({ mode: 'active' }, runtime)
  if (scheduler === 'interval') return startRepeatingPruneBackground(runtime)
  runtime.worker.start()
  return () => runtime.worker.stop()
}
