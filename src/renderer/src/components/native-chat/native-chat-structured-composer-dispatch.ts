import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

/**
 * `beforeSend` runs only when the text goes out as a message; the transport takes it once that
 * settles, unless it settled `false` (the send was cancelled meanwhile).
 */
export async function dispatchNativeChatStructuredComposerText(
  transport: NativeChatStructuredComposerTransport,
  text: string,
  attachments: readonly NativeChatComposerImageAttachment[] = [],
  beforeSend?: () => Promise<boolean>
): Promise<{ accepted: boolean; error: string | null; cancelled?: true }> {
  const command = await transport.dispatchCommand(text)
  if (command.handled) {
    return { accepted: command.accepted, error: command.error }
  }
  if (beforeSend && !(await beforeSend())) {
    return { accepted: false, error: null, cancelled: true }
  }
  return { accepted: transport.send(text, attachments), error: null }
}
