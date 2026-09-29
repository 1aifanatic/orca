import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export const NATIVE_CHAT_PASTE_REQUEST_EVENT = 'orca-native-chat-paste-request'
export const NATIVE_CHAT_ROOT_SELECTOR = '[data-native-chat-root="true"]'

export class NativeChatPasteRequest extends Event {
  constructor(readonly clipboardData: DataTransfer | null = null) {
    super(NATIVE_CHAT_PASTE_REQUEST_EVENT, { cancelable: true })
  }
}

// A visible chat owns paste even while its input is still mounting.
export function requestNativeChatOverlayPaste(
  container: Element,
  clipboardData: DataTransfer | null = null
): boolean {
  const root = container.querySelector(NATIVE_CHAT_ROOT_SELECTOR)
  if (!root && !container.querySelector('.native-chat-pane-shell')) {
    return false
  }
  const request = new NativeChatPasteRequest(clipboardData)
  root?.dispatchEvent(request)
  if (!request.defaultPrevented) {
    toast.error(
      translate(
        'components.native-chat.composer.worktreeNotReady',
        'Worktree not ready — try again in a moment.'
      )
    )
  }
  return true
}
