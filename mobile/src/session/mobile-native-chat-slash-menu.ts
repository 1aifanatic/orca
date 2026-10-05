import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session-conversation-command'
import type { AgentSessionSlashCommand } from '../../../src/shared/agent-session-wire'
import { getNativeChatAgentProfile } from '../../../src/shared/native-chat-agent-profiles'
import { nativeChatComposerCatalog } from '../../../src/shared/native-chat-composer-catalog'
import {
  buildNativeChatPickerItems,
  type NativeChatPickerItem
} from '../../../src/shared/native-chat-picker-items'

export type MobileNativeChatSlashMenu = {
  /** Whether the rows carry Commands / Skills headings (the agent has a known grammar). */
  grouped: boolean
  commands: NativeChatPickerItem[]
  skills: NativeChatPickerItem[]
}

const EMPTY_MENU: MobileNativeChatSlashMenu = { grouped: false, commands: [], skills: [] }
const NO_CONVERSATION_COMMANDS: readonly AgentSessionConversationCommand[] = []

/** The `structuredCommands` input: defined exactly on the structured lane, and a
 *  stable empty list there so the menu memo survives streamed frames. */
export function structuredLaneCommands(
  structured: boolean,
  supported: readonly AgentSessionConversationCommand[] | undefined
): readonly AgentSessionConversationCommand[] | undefined {
  return structured ? (supported ?? NO_CONVERSATION_COMMANDS) : undefined
}

/**
 * The phone's `/` menu, built by the same catalog selection and row policy as the
 * desktop composer. The phone does no disk scan, so skills come only from the
 * session's own report.
 */
export function mobileNativeChatSlashMenu(args: {
  agent: string | null | undefined
  /** Defined exactly on the structured lane, even before the host answers. */
  structuredCommands: readonly AgentSessionConversationCommand[] | undefined
  sessionCommands: readonly AgentSessionSlashCommand[] | undefined
  query: string
}): MobileNativeChatSlashMenu {
  const { agent, structuredCommands, sessionCommands, query } = args
  if (!agent) {
    return EMPTY_MENU
  }
  const { agentCommands, sessionSkills } = nativeChatComposerCatalog(
    agent,
    structuredCommands !== undefined
      ? { sessionCommands, conversationCommands: structuredCommands }
      : undefined
  )
  const profile = getNativeChatAgentProfile(agent)
  const items = buildNativeChatPickerItems(
    agentCommands,
    [],
    query,
    profile?.skillPrefix ?? '/',
    profile ? sessionSkills : []
  )
  return {
    grouped: profile !== null,
    commands: items.filter((item) => item.kind === 'command'),
    skills: items.filter((item) => item.kind === 'skill')
  }
}
