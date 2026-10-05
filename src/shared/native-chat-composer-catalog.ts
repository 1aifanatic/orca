import type { AgentSessionConversationCommand } from './agent-session-conversation-command'
import type { AgentSessionSlashCommand } from './agent-session-wire'
import type { AgentType } from './agent-status-types'
import { getVerifiedNativeChatCommands } from './native-chat-agent-profiles'
import type { NativeChatSessionSkill } from './native-chat-picker-items'
import {
  sessionReportedSkills,
  sessionSlashCommandSuggestions,
  type SlashCommandSuggestion
} from './native-chat-slash-commands'
import { structuredSlashCommands } from './structured-agent-session-composer'

/** A structured session's two `/` inputs; absent on the PTY lane. */
export type NativeChatStructuredCatalogInputs = {
  sessionCommands?: readonly AgentSessionSlashCommand[]
  conversationCommands?: readonly AgentSessionConversationCommand[]
}

export type NativeChatComposerCatalog = {
  agentCommands: readonly SlashCommandSuggestion[]
  sessionSkills: readonly NativeChatSessionSkill[] | undefined
}

/**
 * What the `/` menu offers, for the desktop composer and the phone alike. A
 * structured session reports the surface it actually loaded — the only list that
 * includes this repo's own commands and the skills that reach the session through
 * plugin roots — so it wins whenever it is present, even when empty. The curated
 * per-agent catalog remains the answer for the PTY lane, and the host-owned
 * fallback for a structured host that predates the report.
 */
export function nativeChatComposerCatalog(
  agent: AgentType,
  structured?: NativeChatStructuredCatalogInputs
): NativeChatComposerCatalog {
  if (!structured) {
    return { agentCommands: getVerifiedNativeChatCommands(agent), sessionSkills: undefined }
  }
  const reported = structured.sessionCommands
  if (reported === undefined) {
    return {
      agentCommands: structuredSlashCommands(structured.conversationCommands, agent),
      sessionSkills: undefined
    }
  }
  return {
    agentCommands: sessionSlashCommandSuggestions(agent, reported),
    sessionSkills: sessionReportedSkills(reported)
  }
}
