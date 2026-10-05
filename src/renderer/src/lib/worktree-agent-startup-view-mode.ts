import { useAppStore } from '@/store'
import { initialAgentTabViewModeProps } from '@/lib/native-chat-initial-view-mode'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

/** This device's starting view for the agent tab a backend worktree create spawns. */
export function backendAgentViewMode(
  request: Pick<WorktreeCreationRequest, 'agent' | 'repoId' | 'launchDraftPrompt'>
): 'terminal' | 'chat' | undefined {
  if (!request.agent) {
    return undefined
  }
  const state = useAppStore.getState()
  const repo = state.repos.find((entry) => entry.id === request.repoId)
  const connectionId = repo ? (repo.connectionId ?? null) : undefined
  return initialAgentTabViewModeProps(state.settings, {
    agent: request.agent,
    ...(request.launchDraftPrompt
      ? { promptDelivery: 'draft' as const, launchDraftText: request.launchDraftPrompt }
      : {}),
    nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(connectionId)
  }).viewMode
}

/**
 * The startup carrying that view, so the host stamps it at creation (every agent startup, not
 * only drafts: STA-6412).
 */
export function backendAgentStartup(
  request: Pick<WorktreeCreationRequest, 'agent' | 'repoId' | 'launchDraftPrompt' | 'startup'>
): WorktreeCreationRequest['startup'] {
  const viewMode = request.startup ? backendAgentViewMode(request) : undefined
  return viewMode ? { ...request.startup!, viewMode } : request.startup
}
