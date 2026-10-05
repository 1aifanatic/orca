// What `terminal.send` answers, including the prompt delivery receipt.
export type RuntimeTerminalSend = {
  handle: string
  accepted: boolean
  bytesWritten: number
  /** `agent-exited`: a chat-input write after the host proved its agent exited (or that cancelled
   *  the write's action). Older clients read only `accepted`. */
  refusedReason?: 'no-agent' | 'permission' | 'agent-exited'
  /** A chat-input write whose transport settlement was lost: `bytesWritten` is the settled prefix
   *  and later bytes may or may not have arrived. Never sent with `accepted: true`. */
  deliveryUnknown?: true
  prompt?: RuntimeTerminalPromptDelivery
}

export type RuntimeTerminalPromptStage = 'input_accepted' | 'turn_started'

export type RuntimeTerminalPromptDelivery = {
  requestId: string
  stages: RuntimeTerminalPromptStage[]
  provider: 'claude' | 'codex' | 'unsupported' | 'old-host'
  observation: 'supported' | 'unsupported' | 'incarnation_replaced' | 'permission'
  processIncarnation: string
  generation: number
  baselineWorkingSequence: number
  /** Hook turn-start timestamp before this prompt was accepted. */
  baselineExplicitWorkingStartedAt?: number | null
  /** Permission observations seen before this prompt was accepted. */
  baselinePermissionSequence?: number
}
