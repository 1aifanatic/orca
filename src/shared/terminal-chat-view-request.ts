import type { RuntimeSessionTabChatView } from './runtime-session-contracts'

/** Clients treat this as delivery-unknown: the renderer may still have applied the pair. */
export const TERMINAL_CHAT_VIEW_RELAY_TIMEOUT_ERROR = 'chat_view_relay_timeout'

export type TerminalChatViewRequest = {
  requestId: string
  worktreeId: string
  /** The desktop terminal tab id (the host parent tab). */
  tabId: string
  /** The addressed leaf, or null when the write named the parent tab. */
  leafId: string | null
  viewMode: 'terminal' | 'chat'
}

export type TerminalChatViewResponse = {
  requestId: string
  chatView?: RuntimeSessionTabChatView
  error?: string
}
