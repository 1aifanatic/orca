import { createContext } from 'react'

/** The host's live "reasoning open" gate for the transcript: the session's own agent without an
 *  id, else that subagent. A context because roster entries draw deep inside message rows. */
export const NativeChatReasoningOpenContext = createContext<(agentId?: string) => boolean>(
  () => false
)
