/** What a change in an SSH host's server means for the rest of the app. */
import { toast } from 'sonner'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import {
  getRepoExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import {
  canMoveSshHostToManagedServer,
  managedServerMoveOfferText,
  moveSshHostFromToast
} from '@/ssh/ssh-managed-server-move'
import { useAppStore } from '../../store'
import { withoutConvertedSshHostRows } from '../../store/repos/converted-ssh-host-rows'

type ManagedServerStatus = SshConnectionState['managedServer']

export function applySshManagedServerTransition(
  targetId: string,
  previous: ManagedServerStatus,
  next: ManagedServerStatus
): void {
  if (next?.kind === 'managed') {
    // Starts and wakes keep the same owner; only a new server or a failed load needs a refresh.
    if (catalogLoadByTarget.get(targetId)?.environmentId !== next.environmentId) {
      const load = { environmentId: next.environmentId }
      catalogLoadByTarget.set(targetId, load)
      void loadManagedServerCatalogs(targetId, load).catch((error: unknown) => {
        if (catalogLoadByTarget.get(targetId) === load) {
          catalogLoadByTarget.delete(targetId)
        }
        console.warn('[ssh] Could not load the managed server catalogs:', error)
      })
    }
    return
  }
  if (next?.kind === 'relay') {
    catalogLoadByTarget.delete(targetId)
  }
  if (isNewMoveOffer(previous, next) && canMoveSshHostToManagedServer()) {
    offerManagedServerMove(targetId, next.terminals)
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
    // `detail` is main's English refusal; the SSH Hosts status line shows it under "Details".
    toast.error(
      translate(
        'auto.hooks.ipcEvents.sshManagedServer.refusedBlocked',
        'This SSH host could not move to a managed Orca server. SSH Hosts in Settings shows why.'
      )
    )
  }
}

const catalogLoadByTarget = new Map<string, { environmentId: string }>()

/** Loads a newly managed host's server and the local catalogs, then drops its relay-era rows. */
async function loadManagedServerCatalogs(
  targetId: string,
  load: { environmentId: string }
): Promise<void> {
  const { environmentId } = load
  const isCurrent = (): boolean => catalogLoadByTarget.get(targetId) === load
  const store = useAppStore.getState()
  // Why: host badges read server names from this catalog, which a conversion does not refresh.
  const environments = await window.api.runtimeEnvironments.list()
  if (!isCurrent()) {
    return
  }
  store.setRuntimeEnvironments(environments)
  void store.refreshRuntimeEnvironmentStatus(environmentId)
  // Why local too: the host's relay-era rows come from the local catalog, which main now hides.
  for (const runtimeEnvironmentId of [null, environmentId]) {
    const options = { runtimeEnvironmentId, throwOnError: true }
    await store.fetchRepos(options)
    if (!isCurrent()) {
      return
    }
    // Why groups before folders: folder workspaces are owned through their project groups.
    await store.fetchProjectGroups(options)
    if (!isCurrent()) {
      return
    }
    await store.fetchFolderWorkspaces(options)
    if (!isCurrent()) {
      return
    }
  }
  // Why gated: startup runs its own scan once every host's catalog is in.
  if (useAppStore.getState().startupWorktreeRefreshCompleted) {
    const executionHostId = toRuntimeExecutionHostId(environmentId)
    const repos = useAppStore
      .getState()
      .repos.filter((repo) => getRepoExecutionHostId(repo) === executionHostId)
    await Promise.all(repos.map((repo) => store.fetchWorktrees(repo.id, { executionHostId })))
  }
  if (!isCurrent()) {
    return
  }
  useAppStore.setState((state) => withoutConvertedSshHostRows(state, targetId))
  rehomeActiveWorkspace(targetId, environmentId)
}

/** Why: an active workspace left on the SSH host keeps showing panes that dial the stopped relay. */
function rehomeActiveWorkspace(targetId: string, environmentId: string): void {
  const state = useAppStore.getState()
  const runtimeHostId = toRuntimeExecutionHostId(environmentId)
  if (
    state.activeWorktreeId &&
    state.activeWorkspaceExecutionHostId === toSshExecutionHostId(targetId) &&
    state.getKnownWorktreeById(state.activeWorktreeId, runtimeHostId)
  ) {
    state.setActiveWorktree(state.activeWorktreeId, runtimeHostId)
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

function offerManagedServerMove(targetId: string, terminals: number | undefined): void {
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
