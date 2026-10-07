import type { TuiAgent } from './tui-agent'

/**
 * `owed`: no byte of the prompt has been written, so a host that restarts may still deliver it.
 * `writing`: the write may have begun, so nothing may write it again.
 */
export type AgentLaunchOwedPrompt =
  | {
      state: 'owed'
      text: string
      agent: TuiAgent
      deadline: number
      /** The PTY the launch started its agent in: a resume pastes into that one only. */
      terminal: { ptyId: string; incarnationId: string | null } | null
    }
  | { state: 'writing'; since: number }
