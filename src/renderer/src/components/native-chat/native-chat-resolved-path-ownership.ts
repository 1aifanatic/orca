import { translate } from '@/i18n/i18n'
import type {
  NativeChatAttachmentHostOwner,
  NativeChatAttachmentOwner
} from './native-chat-attachment-upload'

export type NativeChatResolvedPathOptions = {
  /** Revalidates internal path ownership when an IME-delayed attachment is applied. */
  targetOwnerIsCurrent?: () => boolean
  /** The paired server store these paths were uploaded into; checked again at send. */
  hostOwner?: NativeChatAttachmentHostOwner
}

/** Same server, same pairing, same chat: a reconnect or server restart keeps all three. */
export function nativeChatAttachmentHostOwnerMatches(
  a: NativeChatAttachmentHostOwner,
  b: NativeChatAttachmentHostOwner
): boolean {
  return (
    a.environmentId === b.environmentId &&
    a.pairingRevision === b.pairingRevision &&
    a.sessionId === b.sessionId
  )
}

export function nativeChatWorkspaceAttachmentMismatchNotice(): string {
  return translate(
    'components.native-chat.composer.workspaceAttachmentMismatch',
    'Files can only be attached to their source workspace.'
  )
}

/** Whether an attachment captured against `captured` may still land on `current`.
 *  `not-ready` never matches: an unknown owner is not evidence of the same one. */
export function nativeChatAttachmentOwnerUnchanged(
  captured: NativeChatAttachmentOwner,
  current: NativeChatAttachmentOwner
): boolean {
  if (captured.kind !== current.kind || captured.kind === 'not-ready') {
    return false
  }
  if (captured.kind === 'runtime-session' && current.kind === 'runtime-session') {
    return nativeChatAttachmentHostOwnerMatches(captured, current)
  }
  if (captured.kind !== 'ssh' || current.kind !== 'ssh') {
    return true
  }
  return (
    captured.connectionId === current.connectionId &&
    captured.worktreePath === current.worktreePath &&
    captured.expectedExecutionHostId === current.expectedExecutionHostId &&
    captured.expectedSshTargetId === current.expectedSshTargetId &&
    captured.expectedSshConnectionGeneration === current.expectedSshConnectionGeneration
  )
}
