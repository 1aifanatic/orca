import { CircleX } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

type FailedDeleteRow = Pick<
  Worktree,
  'id' | 'displayName' | 'hostId' | 'removalError' | 'runtimeOwnerEnvironmentId'
>

/**
 * A local row whose delete failed partway: Delete retries it, this removes it from Orca only. Only
 * rows this window's own main process lists qualify, since that process holds the failed delete.
 */
export function canForgetFailedLocalDelete(
  worktree: FailedDeleteRow,
  repo: Pick<Repo, 'connectionId'> | null | undefined
): boolean {
  return (
    Boolean(worktree.removalError) &&
    // Why the repo only without a hostId: a repo looked up by id may be another host's copy.
    (worktree.hostId
      ? parseExecutionHostId(worktree.hostId)?.kind === 'local'
      : !repo?.connectionId) &&
    !worktree.runtimeOwnerEnvironmentId &&
    !isPairedWebClientWindow()
  )
}

export function ForgetFailedDeleteMenuItem({
  worktree,
  repo,
  disabled
}: {
  worktree: FailedDeleteRow
  repo: Pick<Repo, 'connectionId'> | null | undefined
  disabled: boolean
}): React.JSX.Element | null {
  const openModal = useAppStore((s) => s.openModal)
  if (!canForgetFailedLocalDelete(worktree, repo)) {
    return null
  }
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={() =>
        openModal('forget-ssh-workspace', {
          worktreeId: worktree.id,
          displayName: worktree.displayName,
          resolution: { kind: 'not-ssh' },
          ...(worktree.hostId ? { executionHostId: worktree.hostId } : {})
        })
      }
    >
      <CircleX className="size-3.5" />
      {translate('auto.components.sidebar.ForgetSshWorkspaceDialog.forget', 'Remove from Orca')}
    </DropdownMenuItem>
  )
}
