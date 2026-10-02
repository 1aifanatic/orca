import { NATIVE_CHAT_TURN_STATUS_COPY } from '../../../src/shared/native-chat-turn-status'
import type { MobileNativeChatInputLockReason } from './MobileNativeChatView'

/** The chat composer's placeholder: why it is locked, else that a message sent now runs after a
 *  Stop the chat reads as stopping, else the usual prompt. */
export function mobileNativeChatComposerPlaceholder(
  lockReason: MobileNativeChatInputLockReason | null,
  stopping: boolean
): string {
  if (lockReason === 'disconnected') {
    return 'Reconnecting…'
  }
  if (lockReason === 'waiting') {
    return 'Waiting for terminal…'
  }
  return stopping ? NATIVE_CHAT_TURN_STATUS_COPY.queueAfterStop : 'Message, @files, /commands'
}
