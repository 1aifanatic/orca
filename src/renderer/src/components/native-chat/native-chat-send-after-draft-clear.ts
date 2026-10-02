// A send empties the box at Enter, then hands the message over only once the cleared draft is
// written (bounded), so a crash after the handoff cannot bring the sent text back. The wait is
// tracked like a pending terminal write, so a Stop, Escape or pane swap meanwhile cancels the send
// and the message goes back into the box, as it would have stayed there had Stop come first.

import {
  awaitNativeChatDraftWritten,
  type NativeChatDraftAttachment
} from './native-chat-draft-cache'
import type { NativeChatSendHandle } from './native-chat-runtime-send'
import type { NativeChatSendLifecycle } from './use-native-chat-send-lifecycle'

/** Resolves true once the chat's clear is written (or the wait ran out), false if cancelled. */
export function awaitDraftClearBeforeSend(
  draftKey: string,
  trackPendingSend: NativeChatSendLifecycle['trackPendingSend'],
  pendingId?: string
): Promise<boolean> {
  let cancelled = false
  const written = awaitNativeChatDraftWritten(draftKey)
  trackPendingSend(
    {
      cancel: () => {
        cancelled = true
      },
      settleAfterMs: 0,
      settled: written
    },
    pendingId
  )
  return written.then(() => !cancelled)
}

/** Every terminal send: the write runs only once the clear is written, unless cancelled. */
export async function writeToPtyAfterDraftClear(args: {
  draftKey: string
  trackPendingSend: NativeChatSendLifecycle['trackPendingSend']
  pendingId?: string
  write: () => NativeChatSendHandle | null
  putBack: () => void
}): Promise<void> {
  if (!(await awaitDraftClearBeforeSend(args.draftKey, args.trackPendingSend, args.pendingId))) {
    args.putBack()
    return
  }
  const handle = args.write()
  if (handle) {
    args.trackPendingSend(handle, args.pendingId)
  }
}

/** The draft's copy of composer image chips, for putting a message back. */
export function nativeChatDraftAttachmentsOf(
  attachments: readonly NativeChatDraftAttachment[]
): NativeChatDraftAttachment[] {
  return attachments.map(({ id, path, connectionId, location }) => ({
    id,
    path,
    ...(connectionId ? { connectionId } : {}),
    ...(location ? { location } : {})
  }))
}
