// The ordinary PTY message seam for an async-question answer, with the outcome the
// runtime write observed: refused → rejected, acknowledgement lost → unknown.
// Unlike the composer, it never touches the draft, history, or attachments.

import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { sendNativeChatMessage, type NativeChatSendHandle } from './native-chat-runtime-send'

export type NativeChatPtySendOutcome = 'accepted' | 'rejected' | 'unknown'

export function sendNativeChatMessageWithOutcome(
  settings: ReturnType<typeof getSettingsForAgentTabRuntimeOwner>,
  ptyId: string,
  text: string
): { handle: NativeChatSendHandle; outcome: Promise<NativeChatPtySendOutcome> } {
  let observed: NativeChatPtySendOutcome | null = null
  let cancelledBeforeSubmit = false
  const inner = sendNativeChatMessage(settings, ptyId, text, {
    onWriteRejected: () => {
      observed ??= 'rejected'
    },
    onWriteUnconfirmed: () => {
      observed ??= 'unknown'
    }
  })
  const finished =
    'finished' in inner && typeof inner.finished === 'function' ? inner.finished : () => true
  const handle: NativeChatSendHandle = {
    ...inner,
    // A cancel before Enter clears the line, so nothing was sent.
    cancel: () => {
      cancelledBeforeSubmit ||= !finished()
      inner.cancel()
    }
  }
  const settled = inner.settled ?? Promise.resolve()
  const outcome = settled.then(
    (): NativeChatPtySendOutcome => (cancelledBeforeSubmit ? 'rejected' : (observed ?? 'accepted')),
    (): NativeChatPtySendOutcome => 'unknown'
  )
  return { handle, outcome }
}
