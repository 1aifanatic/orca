import type { LucideIcon } from 'lucide-react'
import { FilePenLine, Hand, ShieldAlert, ShieldCheck } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { AgentChatPermissionMode } from '../../../../shared/agent-chat-permission-mode'
import type { SessionOptionsSurface } from '../../../../shared/native-chat-session-options'

/** The composer's permission pill: present only where the host offers a picker for this chat. */
export type NativeChatPermissionModePickerState = {
  current: AgentChatPermissionMode
  supported: readonly AgentChatPermissionMode[]
  /** This pick is in flight. */
  pending: boolean
  /** Nothing can carry a pick right now: another write is in flight, or the launch has no fence. */
  disabled: boolean
  setMode: (mode: AgentChatPermissionMode) => Promise<boolean>
}

/** A structured chat's options surface, which also carries the chat's own permission mode: a
 *  session-level option, apart from the per-model descriptors. Null where the host offers none. */
export type StructuredSessionOptionsSurface = SessionOptionsSurface & {
  permissionPicker?: NativeChatPermissionModePickerState | null
}

export const NATIVE_CHAT_PERMISSION_MODE_ICONS = {
  ask: Hand,
  'accept-edits': FilePenLine,
  auto: ShieldCheck,
  bypass: ShieldAlert
} as const satisfies Record<AgentChatPermissionMode, LucideIcon>

export function nativeChatPermissionModeLabel(mode: AgentChatPermissionMode): string {
  switch (mode) {
    case 'ask':
      return translate('components.native-chat.composer.permissionAsk', 'Ask for approval')
    case 'accept-edits':
      return translate('components.native-chat.composer.permissionAcceptEdits', 'Accept edits')
    case 'auto':
      return translate('components.native-chat.composer.permissionAuto', 'Approve for me')
    case 'bypass':
      return translate('components.native-chat.composer.permissionBypass', 'Full access')
  }
}

export function nativeChatPermissionModeDescription(mode: AgentChatPermissionMode): string {
  switch (mode) {
    case 'ask':
      return translate(
        'components.native-chat.composer.permissionAskDescription',
        'Always asks before edits and commands'
      )
    case 'accept-edits':
      return translate(
        'components.native-chat.composer.permissionAcceptEditsDescription',
        'Edits files without asking; asks before commands'
      )
    case 'auto':
      return translate(
        'components.native-chat.composer.permissionAutoDescription',
        'Only asks for actions detected as potentially unsafe'
      )
    case 'bypass':
      return translate(
        'components.native-chat.composer.permissionBypassDescription',
        'Never asks; unrestricted access to your computer'
      )
  }
}

export function nativeChatPermissionPickerTitle(): string {
  return translate('components.native-chat.composer.permissions', 'Permissions')
}
