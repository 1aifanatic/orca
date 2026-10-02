import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

/** `beforeSend` runs only when the text goes out as a message; the transport takes it once that settles. */
export async function dispatchNativeChatStructuredComposerText(
  transport: NativeChatStructuredComposerTransport,
  text: string,
  attachments: readonly NativeChatComposerImageAttachment[] = [],
  beforeSend?: () => void | Promise<void>
): Promise<{ accepted: boolean; error: string | null }> {
  const command = await transport.dispatchCommand(text)
  if (command.handled) {
    return { accepted: command.accepted, error: command.error }
  }
  await beforeSend?.()
  return { accepted: transport.send(text, attachments), error: null }
}
