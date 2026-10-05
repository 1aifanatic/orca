import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { useFocusEffect } from 'expo-router'
import { TERMINAL_CHAT_VIEW_RELAY_TIMEOUT_ERROR } from '../../../src/shared/terminal-chat-view-request'
import { HOST_TERMINAL_SURFACE_SEPARATOR } from '../../../src/shared/terminal-surface-id'
import type { TerminalChatPair } from '../../../src/shared/terminal-tab-view-mode'
import {
  refreshDefaultSessionView,
  useDefaultSessionView
} from '../storage/default-session-view-store'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import {
  bindMobileChatPairRoute,
  getMobileChatPairWrites,
  mobileChatPairKeysInScope,
  type MobileChatPairRouteBinding
} from './mobile-session-chat-pair-writes'
import {
  chatPairToggleTarget,
  chatViewIdentityFence,
  chatViewLeafId,
  chatViewLeafIds,
  chatViewParentTabId,
  hostChatPairForRow,
  resolveMobileLeafView,
  type MobileChatViewInputs,
  type MobileLeafView,
  type MobileNativeChatReadability
} from './mobile-session-chat-view'
import type { MobileSessionTab } from './mobile-session-route-types'
import { sessionTabChatViewWrite } from './mobile-session-write-operations'
import { resolveMobileNativeChat } from './mobile-native-chat-eligibility'
import { useMobileSessionViewMode } from './use-mobile-session-view-mode'

export const CHAT_VIEW_SWITCH_UNCONFIRMED_MESSAGE = "Couldn't confirm the view switch"

const CHAT_VIEW_WRITE_TIMEOUT_MS = 15_000

type TerminalRow = Extract<MobileSessionTab, { type: 'terminal' }>

export type MobileSessionChatView = {
  /** Whether the latest accepted snapshot came from a host that owns the chat pair. */
  markerSession: boolean
  tabLeafView: (tab: MobileSessionTab | null) => MobileLeafView
  isTabChatView: (tabId: string) => boolean
  toggleTabChatView: (tabId: string) => void
}

function terminalRows(tabs: readonly MobileSessionTab[]): TerminalRow[] {
  return tabs.filter((tab): tab is TerminalRow => tab.type === 'terminal')
}

/**
 * Which view each terminal leaf shows. On a host that owns the chat pair the phone renders that
 * pair (with its own pending click on top) and sends fenced writes; otherwise the device-local
 * legacy overrides still decide.
 */
export function useMobileSessionChatView(args: {
  hostId: string
  worktreeId: string
  client: RpcClient | null
  sessionTabs: readonly MobileSessionTab[]
  sessionTabsRef: MutableRefObject<MobileSessionTab[]>
  markerSession: boolean
  readability: MobileNativeChatReadability
  onSwitchUnconfirmed: (message: string) => void
}): MobileSessionChatView {
  const { hostId, worktreeId, client, sessionTabs, sessionTabsRef, markerSession, readability } =
    args
  // Why always mounted: hooks cannot be conditional; on marker sessions its overrides are never consulted or written.
  const { isTabChatView: legacyIsTabChatView, toggleTabChatView: legacyToggleTabChatView } =
    useMobileSessionViewMode({ hostId, worktreeId })
  const defaultView = useDefaultSessionView()
  const inputs: MobileChatViewInputs = { defaultView, readability }
  const inputsRef = useRef(inputs)
  inputsRef.current = inputs
  const clientRef = useRef(client)
  clientRef.current = client
  const onSwitchUnconfirmedRef = useRef(args.onSwitchUnconfirmed)
  onSwitchUnconfirmedRef.current = args.onSwitchUnconfirmed
  const [pendingState, setPendingState] = useState<{
    scope: string
    pairs: ReadonlyMap<string, TerminalChatPair>
  }>({ scope: '', pairs: new Map() })
  const scope = `${hostId}\0${worktreeId}`
  const pendingPairs = pendingState.scope === scope ? pendingState.pairs : null

  useFocusEffect(
    useCallback(() => {
      void refreshDefaultSessionView()
    }, [])
  )

  useEffect(() => {
    const readRows = (parentTabId: string): TerminalRow[] =>
      terminalRows(sessionTabsRef.current).filter((row) => chatViewParentTabId(row) === parentTabId)
    const binding: MobileChatPairRouteBinding = {
      readHostPair: (parentTabId) => {
        const row = readRows(parentTabId)[0]
        return row ? hostChatPairForRow(row) : null
      },
      send: async (parentTabId, request, write) => {
        const currentClient = clientRef.current
        if (!currentClient) {
          throw new Error('Not connected')
        }
        const response = await sessionTabChatViewWrite.request(
          currentClient,
          {
            worktree: `id:${worktreeId}`,
            tabId: request.leafId
              ? `${parentTabId}${HOST_TERMINAL_SURFACE_SEPARATOR}${request.leafId}`
              : parentTabId,
            viewMode: request.viewMode,
            chatViewWrite: write
          },
          { timeoutMs: CHAT_VIEW_WRITE_TIMEOUT_MS }
        )
        // Why: the host's relay to its desktop timed out, so the write may still land; resend once.
        if (!response.ok && response.error.code === TERMINAL_CHAT_VIEW_RELAY_TIMEOUT_ERROR) {
          throw markRpcDeliveryUnknown(new Error(response.error.message))
        }
        return sessionTabChatViewWrite.interpret(response)
      },
      showPending: (parentTabId, pair) => {
        setPendingState((current) => {
          const pairs = new Map(current.scope === scope ? current.pairs : [])
          if (pair) {
            pairs.set(parentTabId, pair)
          } else if (!pairs.delete(parentTabId)) {
            return current
          }
          return { scope, pairs }
        })
      },
      reportFailure: () => onSwitchUnconfirmedRef.current(CHAT_VIEW_SWITCH_UNCONFIRMED_MESSAGE)
    }
    const unbind = bindMobileChatPairRoute(hostId, worktreeId, binding)
    return () => {
      for (const key of mobileChatPairKeysInScope(hostId, worktreeId)) {
        getMobileChatPairWrites().drop(key)
      }
      unbind()
    }
  }, [hostId, scope, sessionTabsRef, worktreeId])

  const appliedRef = useRef<{ scope: string; marker: boolean; fences: Map<string, string> }>({
    scope: '',
    marker: false,
    fences: new Map()
  })
  useEffect(() => {
    const writes = getMobileChatPairWrites()
    const rows = terminalRows(sessionTabs)
    const fences = new Map(rows.map((row) => [row.id, chatViewIdentityFence(row)]))
    const previous = appliedRef.current
    appliedRef.current = { scope, marker: markerSession, fences }
    const sameScope = previous.scope === scope
    for (const key of mobileChatPairKeysInScope(hostId, worktreeId)) {
      const parentRows = rows.filter((row) => chatViewParentTabId(row) === key.parentTabId)
      // Why non-empty on both sides: a pending row gaining its first PTY is the same session.
      const incarnationChanged = parentRows.some((row) => {
        const before = previous.fences.get(row.id)
        const after = fences.get(row.id)
        return sameScope && Boolean(before) && Boolean(after) && before !== after
      })
      // Why: a marker flip changes which logic decides, and a new PTY is a different session.
      if (
        (sameScope && previous.marker !== markerSession) ||
        parentRows.length === 0 ||
        incarnationChanged
      ) {
        writes.drop(key)
        continue
      }
      writes.hostPairChanged(key)
    }
  }, [hostId, markerSession, scope, sessionTabs, worktreeId])

  const tabLeafView = useCallback(
    (tab: MobileSessionTab | null): MobileLeafView => {
      if (tab?.type === 'agent-session') {
        return 'chat'
      }
      if (tab?.type !== 'terminal') {
        return 'terminal'
      }
      if (!markerSession) {
        return legacyIsTabChatView(tab.id) &&
          resolveMobileNativeChat(tab, readability === 'readable')
          ? 'chat'
          : 'terminal'
      }
      const pair = pendingPairs?.get(chatViewParentTabId(tab)) ?? hostChatPairForRow(tab)
      return resolveMobileLeafView(tab, pair, chatViewLeafIds(tab, terminalRows(sessionTabs)), {
        defaultView,
        readability
      })
    },
    [defaultView, legacyIsTabChatView, markerSession, pendingPairs, readability, sessionTabs]
  )

  const isTabChatView = useCallback(
    (tabId: string) => tabLeafView(sessionTabs.find((tab) => tab.id === tabId) ?? null) === 'chat',
    [sessionTabs, tabLeafView]
  )

  const toggleTabChatView = useCallback(
    (tabId: string) => {
      if (!markerSession) {
        legacyToggleTabChatView(tabId)
        return
      }
      const rows = terminalRows(sessionTabsRef.current)
      const row = rows.find((candidate) => candidate.id === tabId)
      if (!row) {
        return
      }
      const key = { hostId, worktreeId, parentTabId: chatViewParentTabId(row) }
      const writes = getMobileChatPairWrites()
      // Why the writer's own pending pair: two quick clicks must stack, not both start from the host.
      const pair = writes.pendingPair(key) ?? hostChatPairForRow(row)
      const target = chatPairToggleTarget(row, pair, chatViewLeafIds(row, rows), inputsRef.current)
      writes.submit(
        key,
        { viewMode: target.viewMode ?? 'terminal', leafId: chatViewLeafId(row) },
        target
      )
    },
    [hostId, legacyToggleTabChatView, markerSession, sessionTabsRef, worktreeId]
  )

  return { markerSession, tabLeafView, isTabChatView, toggleTabChatView }
}
