import type { ActiveBrowserScreencastSubscriber } from './runtime-browser-commands-browser-command-target-params'
import { recordScreencastSubscriberSend } from './browser-screencast-ghost-subscriber-eviction'
import { sendRemoteBrowserScreencastFrame } from './remote-browser-screencast-frame-admission'

// Why 50: the frame pacer's own backpressure retry interval.
export const SCREENCAST_PENDING_FRAME_RETRY_MS = 50

/**
 * Sends one frame to one viewer. A refused frame is kept as the viewer's newest pending frame and
 * retried until its socket takes it: an idle page produces no next frame, so without the retry a
 * viewer behind a briefly full socket keeps a stale picture until the page changes.
 */
export function deliverScreencastSubscriberFrame(
  subscriber: ActiveBrowserScreencastSubscriber,
  bytes: Uint8Array<ArrayBufferLike>,
  isSubscribed: () => boolean
): boolean {
  const delivered = sendRemoteBrowserScreencastFrame(subscriber.sendBinary, bytes)
  subscriber.pendingFrame = delivered ? null : bytes
  subscriber.delivery = recordScreencastSubscriberSend(subscriber.delivery, delivered)
  if (!delivered) {
    schedulePendingFrameRetry(subscriber, isSubscribed)
  }
  return delivered
}

function schedulePendingFrameRetry(
  subscriber: ActiveBrowserScreencastSubscriber,
  isSubscribed: () => boolean
): void {
  if (subscriber.pendingFrameRetry) {
    return
  }
  subscriber.pendingFrameRetry = setTimeout(() => {
    subscriber.pendingFrameRetry = null
    const bytes = subscriber.pendingFrame
    if (!bytes || !isSubscribed()) {
      return
    }
    // Why a refused retry is not recorded: ghost eviction must advance only on produced frames.
    if (sendRemoteBrowserScreencastFrame(subscriber.sendBinary, bytes)) {
      subscriber.pendingFrame = null
      subscriber.delivery = recordScreencastSubscriberSend(subscriber.delivery, true)
    } else {
      schedulePendingFrameRetry(subscriber, isSubscribed)
    }
  }, SCREENCAST_PENDING_FRAME_RETRY_MS)
}
