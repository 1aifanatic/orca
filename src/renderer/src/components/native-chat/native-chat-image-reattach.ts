import { translate } from '@/i18n/i18n'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

/** Why the composer can't send while it holds images Orca couldn't keep; null when it holds none. */
export function nativeChatAttachImagesAgainReason(
  attachments: readonly NativeChatComposerImageAttachment[]
): string | null {
  const count = attachments.filter((attachment) => attachment.unavailableName !== undefined).length
  if (count === 0) {
    return null
  }
  return count === 1
    ? translate(
        'components.native-chat.composer.attachImageAgain',
        'Attach the image again or remove it'
      )
    : translate(
        'components.native-chat.composer.attachImagesAgain',
        'Attach the images again or remove them'
      )
}

/** A chip still saving, or one to attach again, has no path the agent can read yet. */
export function nativeChatImagesHoldSend(
  attachments: readonly NativeChatComposerImageAttachment[]
): boolean {
  return attachments.some(
    (attachment) => attachment.pending || attachment.unavailableName !== undefined
  )
}

/** Whether the composer's images keep it from sending, and the reason to show when the user can
 *  fix it. */
export function nativeChatImageSendBlock(
  attachments: readonly NativeChatComposerImageAttachment[]
): { holdsSend: boolean; reason: string | null } {
  return {
    holdsSend: nativeChatImagesHoldSend(attachments),
    reason: nativeChatAttachImagesAgainReason(attachments)
  }
}
