import type { StructuredAgentSessionCommandOutcome } from '../../../../shared/structured-agent-session-composer'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

export async function dispatchNativeChatStructuredComposerText(
  transport: NativeChatStructuredComposerTransport,
  text: string,
  attachments: readonly NativeChatComposerImageAttachment[] = []
): Promise<Omit<StructuredAgentSessionCommandOutcome, 'handled'>> {
  const { handled, ...command } = await transport.dispatchCommand(text)
  if (handled) {
    return command
  }
  return { accepted: transport.send(text, attachments), error: null }
}
