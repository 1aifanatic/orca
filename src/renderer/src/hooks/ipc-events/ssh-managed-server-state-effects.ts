/** What a change in an SSH host's server means for the rest of the app. */
import { toast } from 'sonner'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import {
  canMoveSshHostToManagedServer,
  managedServerMoveOfferText,
  moveSshHostFromToast
} from '@/ssh/ssh-managed-server-move'
import { useAppStore } from '../../store'

type ManagedServerStatus = SshConnectionState['managedServer']

export function applySshManagedServerTransition(
  targetId: string,
  previous: ManagedServerStatus,
  next: ManagedServerStatus
): void {
  if (
    next?.kind === 'managed' &&
    (previous?.kind !== 'managed' || previous.environmentId !== next.environmentId)
  ) {
    // Why all hosts: a host that just converted brings a new server whose projects must load.
    void useAppStore.getState().fetchReposForAllHosts()
    return
  }
  if (isNewMoveOffer(previous, next) && canMoveSshHostToManagedServer()) {
    offerManagedServerMove(targetId, next.terminals ?? 0)
    return
  }
  if (
    next?.kind === 'relay' &&
    next.reason === 'refused' &&
    !(
      previous?.kind === 'relay' &&
      previous.reason === 'refused' &&
      previous.detail === next.detail
    )
  ) {
    toast.error(
      translate(
        'auto.hooks.ipcEvents.sshManagedServer.refused',
        'This SSH host could not move to a managed Orca server: {{blocker}}',
        { blocker: next.detail ?? '' }
      )
    )
  }
}

/** Main marks only the first live-terminals stop per host per app version with `offerMove`. */
function isNewMoveOffer(
  previous: ManagedServerStatus,
  next: ManagedServerStatus
): next is Extract<NonNullable<ManagedServerStatus>, { kind: 'relay' }> {
  return (
    next?.kind === 'relay' &&
    next.offerMove === true &&
    !(previous?.kind === 'relay' && previous.offerMove)
  )
}

function offerManagedServerMove(targetId: string, terminals: number): void {
  const host = useAppStore.getState().sshTargetLabels.get(targetId) ?? targetId
  toast(managedServerMoveOfferText(host, terminals), {
    id: `ssh-managed-server-move:${targetId}`,
    duration: Infinity,
    action: {
      label: translate('auto.ssh.managedServerMove.confirm', 'Move'),
      onClick: () => void moveSshHostFromToast(targetId, host)
    },
    // "Not now" only closes the toast; the SSH Hosts status line keeps the action.
    cancel: { label: translate('auto.ssh.managedServerMove.notNow', 'Not now'), onClick: () => {} }
  })
}
