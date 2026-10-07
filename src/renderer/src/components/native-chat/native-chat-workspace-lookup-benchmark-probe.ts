import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { resolveNativeChatAttachmentOwner } from './native-chat-attachment-upload'
import { useNativeChatImageRuntimeContext } from './native-chat-image-runtime-context'
import { nativeChatTabScope, resolveNativeChatBridgeRuntimeSettings } from './native-chat-tab-scope'
import { useNativeChatBridgeWorkspace } from './use-native-chat-bridge-workspace'
import { useNativeChatFileLinkContext } from './use-native-chat-file-link-context'
import { useNativeChatMentionFiles } from './use-native-chat-mention-files'
import { useNativeChatSessionOptions } from './use-native-chat-session-options'
import { useNativeChatSkills } from './use-native-chat-skills'

// The workspace lookups a mounted native chat performs, as this build calls them. The benchmark
// harness is shared across builds; only this file follows each build's call signatures.

export type BenchmarkChat = {
  mode: 'bridge' | 'structured'
  worktreeId: string
  tabId: string
  paneKey: string
  ptyId: string | null
}

export type BenchmarkPickers = { skillsOpen: boolean; mentionQuery: string | null }

const noopDispatch = async (): Promise<void> => {}

function useComposer(chat: BenchmarkChat, pickers: BenchmarkPickers): void {
  const scope = useMemo(
    () => nativeChatTabScope(chat.mode === 'structured', chat.worktreeId, chat.tabId),
    [chat.mode, chat.tabId, chat.worktreeId]
  )
  useNativeChatSkills('codex', scope, pickers.skillsOpen)
  useNativeChatMentionFiles({ query: pickers.mentionQuery, scope })
  useNativeChatSessionOptions({
    agent: 'codex',
    scope,
    targetPtyId: chat.ptyId,
    dispatchCommand: noopDispatch,
    paneKey: chat.paneKey
  })
}

/** NativeChatResolvedView plus its composer. */
export function useBridgeChatLookups(chat: BenchmarkChat, pickers: BenchmarkPickers): void {
  const { scope } = useNativeChatBridgeWorkspace(chat.worktreeId, chat.tabId)
  useNativeChatFileLinkContext(scope)
  useComposer(chat, pickers)
}

/** NativeChatStructuredSession plus its composer. */
export function useStructuredChatLookups(chat: BenchmarkChat, pickers: BenchmarkPickers): void {
  const scope = useMemo(
    () => nativeChatTabScope(true, chat.worktreeId, chat.tabId),
    [chat.tabId, chat.worktreeId]
  )
  useNativeChatFileLinkContext(scope)
  useNativeChatImageRuntimeContext(scope)
  useComposer(chat, pickers)
}

/** One user action round: a composer send, an interactive answer, and an attachment. */
export function runChatActions(chat: BenchmarkChat): void {
  const scope = nativeChatTabScope(chat.mode === 'structured', chat.worktreeId, chat.tabId)
  if (scope.kind === 'bridge') {
    resolveNativeChatBridgeRuntimeSettings(useAppStore.getState(), scope)
    resolveNativeChatBridgeRuntimeSettings(useAppStore.getState(), scope)
  }
  resolveNativeChatAttachmentOwner(useAppStore.getState(), scope)
}
