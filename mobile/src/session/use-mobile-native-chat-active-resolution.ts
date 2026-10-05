import { useLayoutEffect, useRef, type MutableRefObject } from 'react'
import { encodeNativeChatTranscriptIdentity } from '../../../src/shared/native-chat-transcript-retention'
import type { TerminalTabViewMode } from '../../../src/shared/terminal-tab-view-mode'
import {
  resolveMobileNativeChat,
  type MobileNativeChatResolution,
  type MobileNativeChatTab
} from './mobile-native-chat-eligibility'
import type { MobileLeafView } from './mobile-session-chat-view'

/** The active tab's place in the shared chat pair, resolved by `useMobileSessionChatView`. */
export type MobileNativeChatActiveView = {
  markerSession: boolean
  activeLeafView: MobileLeafView
  /** The route's last identity for the active row's terminal process, kept through status lapses. */
  retainedIdentity: MobileNativeChatResolution | null
  isTabChatView: (tabId: string) => boolean
  setTabChatView: (tabId: string, view: TerminalTabViewMode) => void
}

export function useMobileNativeChatActiveResolution(args: {
  hostId: string
  worktreeId: string
  activeSessionTab: MobileNativeChatTab | null
  activeSessionTabId: string | null
  activeHandleRef: MutableRefObject<string | null>
  nativeChatTranscriptIsLocalReadable: boolean
  view: MobileNativeChatActiveView
}): {
  isTabChatView: (tabId: string) => boolean
  setTabChatView: (tabId: string, view: TerminalTabViewMode) => void
  showNativeChat: boolean
  showNativeChatRef: MutableRefObject<boolean>
  activeChatAgent: string | null
  activeChatAgentRef: MutableRefObject<string | null>
  activeChatSessionId: string | null
  activeChatStructured: boolean
  activeChatResolution: ReturnType<typeof resolveMobileNativeChat>
  activeTabAgentWorking: boolean
  nativeChatStatus: MobileNativeChatTab['agentStatus'] | null
  sourceIdentity: string
  streamIdentity: string
  streamScopeKey: string
} {
  const {
    activeHandleRef,
    activeSessionTab,
    activeSessionTabId,
    hostId,
    nativeChatTranscriptIsLocalReadable,
    worktreeId
  } = args
  const { isTabChatView, setTabChatView, markerSession, activeLeafView, retainedIdentity } =
    args.view
  const hostOwnedTerminal = markerSession && activeSessionTab?.type === 'terminal'
  const tabWantsChat =
    activeSessionTab?.type === 'agent-session' ||
    (activeSessionTabId ? isTabChatView(activeSessionTabId) : false)
  const currentIdentity =
    activeSessionTab && activeSessionTabId
      ? resolveMobileNativeChat(activeSessionTab, nativeChatTranscriptIsLocalReadable)
      : null
  // Why: on a host that owns the pair, status picks the identity shown, never whether chat shows.
  const showNativeChat = hostOwnedTerminal
    ? activeLeafView === 'chat'
    : tabWantsChat && currentIdentity != null
  const activeChatResolution = !showNativeChat
    ? null
    : hostOwnedTerminal
      ? retainedIdentity
      : currentIdentity
  const showNativeChatRef = useRef(showNativeChat)
  const activeChatAgent = activeChatResolution?.agent ?? null
  const activeChatAgentRef = useRef<string | null>(activeChatAgent)

  useLayoutEffect(() => {
    showNativeChatRef.current = showNativeChat
    activeChatAgentRef.current = activeChatAgent
  }, [activeChatAgent, showNativeChat])

  const activeChatSessionId = activeChatResolution?.sessionId ?? null
  const activeChatStructured =
    activeChatResolution != null && activeSessionTab?.type === 'agent-session'
  const activeTabStatus = activeSessionTab?.agentStatus
  const activeTabAgentWorking =
    activeTabStatus?.state === 'working' && activeTabStatus.workingMode !== 'monitoring'
  const nativeChatStatus = activeChatResolution && !activeChatStructured ? activeTabStatus : null
  const routeKey = `${hostId}\0${worktreeId}\0${activeSessionTabId ?? ''}`
  const streamIdentity = `${routeKey}\0${activeChatSessionId ?? ''}\0${activeHandleRef.current ?? ''}`
  const providerSessionId = activeSessionTab?.agentStatus?.providerSession?.id ?? ''
  const streamScopeKey = `${routeKey}\0${activeChatSessionId ?? providerSessionId}\0${activeHandleRef.current ?? ''}`

  return {
    isTabChatView,
    setTabChatView,
    showNativeChat,
    showNativeChatRef,
    activeChatAgent,
    activeChatAgentRef,
    activeChatSessionId,
    activeChatStructured,
    activeChatResolution,
    activeTabAgentWorking,
    nativeChatStatus,
    sourceIdentity: encodeNativeChatTranscriptIdentity([hostId, worktreeId]),
    streamIdentity,
    streamScopeKey
  }
}
