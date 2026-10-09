// Resolves a tab to its Agent Session History row, so the tab menu offers the same "Resume in New
// Native Chat" / "Resume in New CLI" move the row menu does, under the row menu's gating.

import type { AppState } from '@/store/types'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import { collectAiVaultTitleRequests } from '@/lib/ai-vault-tab-title-requests'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  isAiVaultSessionResumableContent,
  type AiVaultListArgs,
  type AiVaultListResult,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  isAgentSessionHandleProvider,
  type AgentSessionHandleProvider
} from '../../../../shared/agent-session-provider-handle'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { resolveAiVaultHistorySessionResumeState } from '../right-sidebar/ai-vault-session-resume'
import { resolveAiVaultSessionSurfaceSwitchTargets } from '../right-sidebar/ai-vault-session-surface-switch'
import { resolveAiVaultSessionResumeInChatForWorkspace } from '../right-sidebar/ai-vault-session-resume-in-chat-workspace'
import { resolveAiVaultTargetWorkspacePath } from '../right-sidebar/ai-vault-session-launch-target'
import { resolveAiVaultSessionWorktreeInfo } from '../right-sidebar/ai-vault-session-worktree'

/** What a tab's history row is found by: a native chat tab by the chat it shows, a terminal tab by
 *  the provider conversation its agent reported. */
export type TabSessionHistorySubject = {
  workspaceId: string
  workspacePath: string
  executionHostId: ExecutionHostId
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
    const workspacePath = resolveAiVaultTargetWorkspacePath(state, workspaceId)
    return workspacePath
      ? {
          workspaceId,
          workspacePath,
          executionHostId: getExecutionHostIdForWorktree(state, workspaceId)
        }
      : null
  }
  if (args.structuredSessionId !== undefined) {
    // Only these providers have history rows either move can act on.
    const target = isAgentSessionHandleProvider(args.tab.launchAgent)
      ? workspace(args.tab.worktreeId)
      : null
    return target ? { ...target, kind: 'chat', sessionId: args.structuredSessionId } : null
  }
  // The same pane-to-conversation mapping tab titles use: live agent, then sleeping, then retained.
  const request = collectAiVaultTitleRequests(state).find(
    (candidate) => candidate.tabId === args.tab.id
  )
  const target = request ? workspace(request.worktreeId) : null
  return request && target
    ? {
        ...target,
        kind: 'cli',
        agent: request.agent,
        providerSessionId: request.providerSession.id
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
  const worktreeInfo = resolveAiVaultSessionWorktreeInfo({
    session,
    repos: state.repos,
    worktrees,
    activeWorktreeId: subject.workspaceId
  })
  const resumeState = resolveAiVaultHistorySessionResumeState({
    session,
    worktreeInfo,
    activeWorktreeId: subject.workspaceId,
    worktrees,
    repos: state.repos,
    targetState: state
  })
  const targets = resolveAiVaultSessionSurfaceSwitchTargets(
    session,
    resumeState,
    // A chat row never resumes into another chat, so only a CLI tab asks.
    subject.kind === 'cli'
      ? resolveAiVaultSessionResumeInChatForWorkspace({
          session,
          resumeState,
          activeWorkspaceId: subject.workspaceId,
          targetState: state,
          settings: state.settings
        })
      : null
  )
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

/** Reads the row through the Session History list, scoped to the tab's workspace and host. */
export async function lookupTabSessionHistoryRow(
  subject: TabSessionHistorySubject,
  listSessions: (args: AiVaultListArgs) => Promise<AiVaultListResult>,
  requestToken: string
): Promise<AiVaultSession | null> {
  const list = (force: boolean): Promise<AiVaultListResult> =>
    listSessions({
      scopePaths: [subject.workspacePath],
      executionHostScope: subject.executionHostId,
      requestToken,
      ...(force ? { force: true } : {})
    })
  const cached = await list(false)
  if (cached.cancelled) {
    return null
  }
  const row = findTabSessionHistoryRow(cached.sessions, subject)
  if (row && isAiVaultSessionResumableContent(row)) {
    return row
  }
  // The host caches the list for a minute, so a conversation newer than that needs a fresh scan.
  const fresh = await list(true)
  return fresh.cancelled ? null : findTabSessionHistoryRow(fresh.sessions, subject)
}
