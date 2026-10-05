import React from 'react'
import { Bell, CheckCheck, Copy, ExternalLink, PanelRight, X } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/close-all-context-menus'
import {
  clearActivityThread,
  clearCompletedActivity,
  isClearableActivityThread
} from './activity-clear-completed'
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
  canMarkUnread,
  getTargets,
  onOpen,
  onJump,
  onMarkRead,
  onMarkUnread,
  onMarkManyRead,
  onMarkManyUnread,
  children
}: {
  thread: AgentPaneThread
  canJump: boolean
  canMarkUnread: (thread: AgentPaneThread) => boolean
  /** Called as the menu opens; returns every agent the menu should act on. */
  getTargets?: (thread: AgentPaneThread) => readonly AgentPaneThread[]
  onOpen: (thread: AgentPaneThread) => void
  onJump: (thread: AgentPaneThread) => void
  onMarkRead: (thread: AgentPaneThread) => void
  onMarkUnread: (thread: AgentPaneThread) => void
  onMarkManyRead: (threads: readonly AgentPaneThread[]) => void
  onMarkManyUnread: (threads: readonly AgentPaneThread[]) => void
  /** Receives whether the menu is open, so the row can keep its preview out of the way. */
  children: (menuOpen: boolean) => React.ReactElement
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = React.useState(false)
  // Why a snapshot: the pointerdown on a portaled item clears the list selection before onSelect.
  const [targets, setTargets] = React.useState<readonly AgentPaneThread[]>([thread])

  React.useEffect(() => {
    if (!menuOpen) {
      return
    }
    const closeMenu = (): void => setMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [menuOpen])

  const handleOpenChange = (open: boolean): void => {
    if (open) {
      window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
      setTargets(getTargets?.(thread) ?? [thread])
    }
    setMenuOpen(open)
  }

  return (
    <ContextMenu open={menuOpen} onOpenChange={handleOpenChange}>
      <ContextMenuTrigger asChild>{children(menuOpen)}</ContextMenuTrigger>
      {/* Why no focus restore: refocusing the row would reopen its hover preview and pin it open. */}
      <ContextMenuContent className="w-52" onCloseAutoFocus={(event) => event.preventDefault()}>
        <ContextMenuLabel>
          {translate('auto.components.activity.ActivityThreadContextMenu.agentSection', 'Agent')}
        </ContextMenuLabel>
        {targets.length > 1 ? (
          <ActivityThreadBulkMenuItems
            targets={targets}
            canMarkUnread={canMarkUnread}
            onMarkManyRead={onMarkManyRead}
            onMarkManyUnread={onMarkManyUnread}
          />
        ) : (
          <ActivityThreadSingleMenuItems
            thread={thread}
            canJump={canJump}
            canMarkUnread={canMarkUnread(thread)}
            onOpen={onOpen}
            onJump={onJump}
            onMarkRead={onMarkRead}
            onMarkUnread={onMarkUnread}
          />
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

function ActivityThreadSingleMenuItems({
  thread,
  canJump,
  canMarkUnread,
  onOpen,
  onJump,
  onMarkRead,
  onMarkUnread
}: {
  thread: AgentPaneThread
  canJump: boolean
  canMarkUnread: boolean
  onOpen: (thread: AgentPaneThread) => void
  onJump: (thread: AgentPaneThread) => void
  onMarkRead: (thread: AgentPaneThread) => void
  onMarkUnread: (thread: AgentPaneThread) => void
}): React.JSX.Element {
  return (
    <>
      <ContextMenuItem onSelect={() => onOpen(thread)}>
        <PanelRight />
        {translate('auto.components.activity.ActivityThreadContextMenu.open', 'Open')}
      </ContextMenuItem>
      <ContextMenuItem disabled={!thread.unread} onSelect={() => onMarkRead(thread)}>
        <CheckCheck />
        {translate('auto.components.activity.ActivityThreadContextMenu.markRead', 'Mark as read')}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={thread.unread || !canMarkUnread}
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
    </>
  )
}

// Single-agent actions (Open, Go to workspace, Copy) are hidden, as in the workspace menu.
function ActivityThreadBulkMenuItems({
  targets,
  canMarkUnread,
  onMarkManyRead,
  onMarkManyUnread
}: {
  targets: readonly AgentPaneThread[]
  canMarkUnread: (thread: AgentPaneThread) => boolean
  onMarkManyRead: (threads: readonly AgentPaneThread[]) => void
  onMarkManyUnread: (threads: readonly AgentPaneThread[]) => void
}): React.JSX.Element {
  const unread = targets.filter((target) => target.unread)
  const read = targets.filter((target) => !target.unread && canMarkUnread(target))
  const clearable = targets.filter(isClearableActivityThread)
  return (
    <>
      <ContextMenuItem disabled={unread.length === 0} onSelect={() => onMarkManyRead(unread)}>
        <CheckCheck />
        {unread.length > 0
          ? translate(
              'auto.components.activity.ActivityThreadContextMenu.markManyRead',
              'Mark {{count}} as read',
              { count: unread.length }
            )
          : translate(
              'auto.components.activity.ActivityThreadContextMenu.markRead',
              'Mark as read'
            )}
      </ContextMenuItem>
      <ContextMenuItem disabled={read.length === 0} onSelect={() => onMarkManyUnread(read)}>
        <Bell />
        {read.length > 0
          ? translate(
              'auto.components.activity.ActivityThreadContextMenu.markManyUnread',
              'Mark {{count}} as unread',
              { count: read.length }
            )
          : translate(
              'auto.components.activity.ActivityThreadContextMenu.markUnread',
              'Mark as unread'
            )}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={clearable.length === 0}
        onSelect={() => clearCompletedActivity(clearable)}
      >
        <X />
        {clearable.length > 0
          ? translate(
              'auto.components.activity.ActivityThreadContextMenu.clearMany',
              'Clear {{count}} from list',
              { count: clearable.length }
            )
          : translate(
              'auto.components.activity.ActivityThreadContextMenu.clear',
              'Clear from list'
            )}
      </ContextMenuItem>
    </>
  )
}
