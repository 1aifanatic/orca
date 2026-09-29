import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { createNativeChatMessageReuse } from '../../../../shared/native-chat-row-reuse'
import { projectNativeChatTranscriptMessages } from '../../../../shared/native-chat-transcript-projection'
import { compareMessages } from './native-chat-session-assembler'

export function createNativeChatMessageListProjection(): (
  messages: NativeChatMessage[]
) => NativeChatMessage[] {
  const reuseRows = createNativeChatMessageReuse()
  return (messages) => reuseRows(projectNativeChatTranscriptMessages(messages, compareMessages))
}
