import { useLayoutEffect, useRef, type MutableRefObject } from 'react'
import { encodeNativeChatTranscriptIdentity } from '../../../src/shared/native-chat-transcript-retention'
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
  /** `incarnationId ?? ptyId`: a new PTY drops the retained transcript identity. */
  identityFence: string
  isTabChatView: (tabId: string) => boolean
  toggleTabChatView: (tabId: string) => void
}

type RetainedIdentity = { key: string; identity: MobileNativeChatResolution | null }

/** Keeps the last identity through a status lapse, and a session id the next status omits. */
function retainIdentity(
  retained: RetainedIdentity,
  key: string,
  current: MobileNativeChatResolution | null
): RetainedIdentity {
  const previous = retained.key === key ? retained.identity : null
  if (!current) {
    return { key, identity: previous }
  }
  if (previous && previous.agent === current.agent && !current.sessionId && previous.sessionId) {
    return {
      key,
      identity: {
        ...current,
        sessionId: previous.sessionId,
        transcriptPath: current.transcriptPath ?? previous.transcriptPath
      }
    }
  }
  return { key, identity: current }
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
  toggleTabChatView: (tabId: string) => void
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
  const { isTabChatView, toggleTabChatView, markerSession, activeLeafView } = args.view
  const hostOwnedTerminal = markerSession && activeSessionTab?.type === 'terminal'
  const tabWantsChat =
    activeSessionTab?.type === 'agent-session' ||
    (activeSessionTabId ? isTabChatView(activeSessionTabId) : false)
  const currentIdentity =
    activeSessionTab && activeSessionTabId
      ? resolveMobileNativeChat(activeSessionTab, nativeChatTranscriptIsLocalReadable)
      : null
  const retainedIdentityRef = useRef<RetainedIdentity>({ key: '', identity: null })
  const retained = retainIdentity(
    retainedIdentityRef.current,
    JSON.stringify([hostId, worktreeId, activeSessionTabId ?? '', args.view.identityFence]),
    currentIdentity
  )
  retainedIdentityRef.current = retained
  // Why: on a host that owns the pair, status picks the identity shown, never whether chat shows.
  const showNativeChat = hostOwnedTerminal
    ? activeLeafView === 'chat'
    : tabWantsChat && currentIdentity != null
  const activeChatResolution = !showNativeChat
    ? null
    : hostOwnedTerminal
      ? retained.identity
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
    toggleTabChatView,
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
