// Resolves a tab to its Agent Session History row, so the tab menu offers the same "Resume in New
// Native Chat" / "Resume in New CLI" move the row menu does, under the row menu's gating.

import type { AppState } from '@/store/types'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import { collectAiVaultTitleRequests } from '@/lib/ai-vault-tab-title-requests'
import {
  isAiVaultSessionResumableContent,
  type AiVaultListArgs,
  type AiVaultListResult,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  isAgentSessionHandleProvider,
  type AgentSessionHandleProvider
} from '../../../../shared/agent-session-provider-handle'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { resolveAiVaultSessionSurfaceSwitchTargets } from '../right-sidebar/ai-vault-session-surface-switch'
import { resolveAiVaultHistoryRowResume } from '../right-sidebar/ai-vault-session-resume-in-chat-workspace'
import { resolveAiVaultTargetWorkspacePath } from '../right-sidebar/ai-vault-session-launch-target'
import { resolveAiVaultSessionWorktreeDisplay } from '../right-sidebar/ai-vault-session-worktree'
import {
  aiVaultSessionListArgs,
  cacheAiVaultSessionList,
  readCachedAiVaultSessionList,
  type AiVaultSessionListRequest
} from '../right-sidebar/ai-vault-session-list-request'
import { resolveAiVaultPanelSessionListRequest } from '../right-sidebar/ai-vault-panel-session-list-request'
import { claimAiVaultForcedRescan } from '../right-sidebar/ai-vault-session-refresh'

/** What a tab's history row is found by: a native chat tab by the chat it shows, a terminal tab by
 *  the provider conversation its agent reported. */
export type TabSessionHistorySubject = {
  workspaceId: string
  /** The panel's own list request for this workspace, so both share one cached list. */
  request: AiVaultSessionListRequest
} & (
  | { kind: 'chat'; sessionId: string }
  | {
      kind: 'cli'
      agent: AgentSessionHandleProvider
      providerSessionId: string
    }
)

export type TabSessionSwitch = {
  action: 'resume-in-new-chat' | 'resume-in-new-cli'
  worktreeId: string
}

export function resolveTabSessionHistorySubject(
  state: AppState,
  args: {
    tab: Pick<TerminalTab, 'id' | 'worktreeId' | 'launchAgent'>
    /** Set only for a native chat tab: the chat session it shows. */
    structuredSessionId?: string
  }
): TabSessionHistorySubject | null {
  const workspace = (workspaceId: string) => {
    if (!resolveAiVaultTargetWorkspacePath(state, workspaceId)) {
      return null
    }
    const request = resolveAiVaultPanelSessionListRequest(state, workspaceId)
    // Both moves need a row recorded on this machine: chat ownership is projected only onto local
    // rows, and resume-in-chat refuses any other host, so a remote lookup could never offer either.
    return request.executionHostScope === LOCAL_EXECUTION_HOST_ID ? { workspaceId, request } : null
  }
  if (args.structuredSessionId !== undefined) {
    // Only these providers have history rows either move can act on.
    const target = isAgentSessionHandleProvider(args.tab.launchAgent)
      ? workspace(args.tab.worktreeId)
      : null
    return target ? { ...target, kind: 'chat', sessionId: args.structuredSessionId } : null
  }
  // The same pane-to-conversation mapping tab titles use: live agent, then sleeping, then retained.
  const titleRequest = collectAiVaultTitleRequests(state).find(
    (candidate) => candidate.tabId === args.tab.id
  )
  const target = titleRequest ? workspace(titleRequest.worktreeId) : null
  return titleRequest && target
    ? {
        ...target,
        kind: 'cli',
        agent: titleRequest.agent,
        providerSessionId: titleRequest.providerSession.id
      }
    : null
}

export function findTabSessionHistoryRow(
  sessions: readonly AiVaultSession[],
  subject: TabSessionHistorySubject
): AiVaultSession | null {
  return (
    sessions.find((session) => {
      if (session.subagent) {
        return false
      }
      if (subject.kind === 'chat') {
        return session.structuredSession?.sessionId === subject.sessionId
      }
      return (
        !session.structuredSession &&
        session.agent === subject.agent &&
        session.sessionId === subject.providerSessionId
      )
    }) ?? null
  )
}

/** The row's move under the Session History gate, with the tab's own workspace standing in for the
 *  active one. A chat tab only forks into a CLI; a CLI tab only resumes into a chat. */
export function resolveTabSessionSwitch(
  state: AppState,
  session: AiVaultSession,
  subject: TabSessionHistorySubject
): TabSessionSwitch | null {
  const worktrees = getIndexedAllWorktrees(state.worktreesByRepo)
  const { resumeState, resumeInChat } = resolveAiVaultHistoryRowResume({
    session,
    worktreeInfo: resolveAiVaultSessionWorktreeDisplay({
      session,
      repos: state.repos,
      worktrees,
      activeWorktreeId: subject.workspaceId
    }),
    activeWorktreeId: subject.workspaceId,
    worktrees,
    repos: state.repos,
    targetState: state,
    settings: state.settings
  })
  const targets = resolveAiVaultSessionSurfaceSwitchTargets(session, resumeState, resumeInChat)
  if (subject.kind === 'chat') {
    return targets.resumeInNewCliWorktreeId
      ? {
          action: 'resume-in-new-cli',
          worktreeId: targets.resumeInNewCliWorktreeId
        }
      : null
  }
  return targets.resumeInNewChatWorkspaceId
    ? {
        action: 'resume-in-new-chat',
        worktreeId: targets.resumeInNewChatWorkspaceId
      }
    : null
}

/** The row as the panel last listed it, so a warm menu shows the move at first paint. */
export function readCachedTabSessionHistoryRow(
  subject: TabSessionHistorySubject
): AiVaultSession | null {
  const cached = readCachedAiVaultSessionList(subject.request)
  const row = cached ? findTabSessionHistoryRow(cached.sessions, subject) : null
  return row && isAiVaultSessionResumableContent(row) ? row : null
}

/** Reads the row through the panel's own list request, keeping the panel's cache as it would. */
export async function lookupTabSessionHistoryRow(
  subject: TabSessionHistorySubject,
  listSessions: (args: AiVaultListArgs) => Promise<AiVaultListResult>,
  requestToken: string
): Promise<AiVaultSession | null> {
  const { request } = subject
  const listed = await listSessions(aiVaultSessionListArgs(request, { requestToken }))
  if (listed.cancelled) {
    return null
  }
  cacheAiVaultSessionList(request, listed, { replaceHostEntries: false })
  const row = findTabSessionHistoryRow(listed.sessions, subject)
  // The host caches the list for a minute, so a conversation newer than that needs a fresh scan,
  // taken from the panel's forced-rescan budget so right-clicks cannot amplify full scans.
  if ((row && isAiVaultSessionResumableContent(row)) || !claimAiVaultForcedRescan()) {
    return row
  }
  const fresh = await listSessions(aiVaultSessionListArgs(request, { force: true, requestToken }))
  if (fresh.cancelled) {
    return null
  }
  cacheAiVaultSessionList(request, fresh, { replaceHostEntries: true })
  return findTabSessionHistoryRow(fresh.sessions, subject)
}
