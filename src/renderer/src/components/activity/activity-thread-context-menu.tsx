import React from 'react'
import { Bell, CheckCheck, Copy, ExternalLink, PanelRight, X } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { clearActivityThread, isClearableActivityThread } from './activity-clear-completed'
import { activityThreadRowCopy } from './activity-thread-presentation'
import type { AgentPaneThread } from './activity-thread-types'

type CopyTarget = { key: string; label: string; value: string }

export function getActivityThreadCopyTargets(
  thread: AgentPaneThread,
  hasWorkspace: boolean
): CopyTarget[] {
  const targets: CopyTarget[] = [
    {
      key: 'title',
      label: translate(
        'auto.components.activity.ActivityThreadContextMenu.copyTitle',
        'Agent title'
      ),
      value: activityThreadRowCopy(thread).taskTitle
    }
  ]
  // Why gated: synthetic floating/standalone worktrees fake a branch label and have no path.
  if (!hasWorkspace) {
    return targets
  }
  const identity = getWorktreeGitIdentityDisplay(thread.worktree)
  if (identity?.kind === 'branch') {
    targets.push({
      key: 'branch',
      label: translate('auto.components.activity.ActivityThreadContextMenu.copyBranch', 'Branch'),
      value: identity.branchName
    })
  }
  if (thread.worktree.path) {
    targets.push({
      key: 'path',
      label: translate('auto.components.activity.ActivityThreadContextMenu.copyPath', 'Path'),
      value: thread.worktree.path
    })
  }
  return targets
}

/** Right-click actions for an activity row; mirrors the row's own click and hover actions. */
export function ActivityThreadContextMenu({
  thread,
  canJump,
  disableMarkUnread,
  onOpen,
  onJump,
  onMarkRead,
  onMarkUnread,
  children
}: {
  thread: AgentPaneThread
  canJump: boolean
  disableMarkUnread: boolean
  onOpen: (thread: AgentPaneThread) => void
  onJump: (thread: AgentPaneThread) => void
  onMarkRead: (thread: AgentPaneThread) => void
  onMarkUnread: (thread: AgentPaneThread) => void
  children: React.ReactElement
}): React.JSX.Element {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onOpen(thread)}>
          <PanelRight />
          {translate('auto.components.activity.ActivityThreadContextMenu.open', 'Open')}
        </ContextMenuItem>
        <ContextMenuItem disabled={!thread.unread} onSelect={() => onMarkRead(thread)}>
          <CheckCheck />
          {translate('auto.components.activity.ActivityThreadContextMenu.markRead', 'Mark as read')}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={thread.unread || disableMarkUnread}
          onSelect={() => onMarkUnread(thread)}
        >
          <Bell />
          {translate(
            'auto.components.activity.ActivityThreadContextMenu.markUnread',
            'Mark as unread'
          )}
        </ContextMenuItem>
        {canJump ? (
          <ContextMenuItem onSelect={() => onJump(thread)}>
            <ExternalLink />
            {translate(
              'auto.components.activity.ActivityThreadContextMenu.goToWorkspace',
              'Go to workspace'
            )}
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Copy />
            {translate('auto.components.activity.ActivityThreadContextMenu.copy', 'Copy')}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {getActivityThreadCopyTargets(thread, canJump).map((target) => (
              <ContextMenuItem
                key={target.key}
                onSelect={() => void window.api.ui.writeClipboardText(target.value)}
              >
                {target.label}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        {isClearableActivityThread(thread) ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => clearActivityThread(thread)}>
              <X />
              {translate(
                'auto.components.activity.ActivityThreadContextMenu.clear',
                'Clear from list'
              )}
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}
