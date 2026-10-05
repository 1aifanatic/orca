import { ipcMain } from 'electron'
import type {
  SshConfigHostListArgs,
  SshRepoReadoption,
  SshTargetCreateInput,
  SshTargetUpdateInput
} from '../../shared/ssh-types'
import {
  listUserSshConfigHostSummaries,
  resolveUserSshConfigHost
} from '../ssh/ssh-config-host-picker'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { closeOrcadManagedTunnel } from '../ssh/orcad-managed-tunnel'
import { rotateSshProviderAuthority } from '../ssh/ssh-provider-authority'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { isManagedOrcadSshTarget, isRuntimeOwnedSshTarget } from '../ssh/ssh-connection-store'
import { getCurrentMainWindow } from './ssh-ipc-context'
import { removeRegisteredSshTarget } from './ssh-session-teardown'

// Why: add/import can re-adopt workspaces orphaned on a removed target id (see ssh-target-readoption); the renderer must refresh its repo list to surface them.
function takeRepoReadoptions(): SshRepoReadoption[] {
  const store = getSshTargetRegistryStore()
  if (!store || store.lastRepoReadoptions.length === 0) {
    return []
  }
  const repoReadoptions = store.lastRepoReadoptions
  store.lastRepoReadoptions = []
  for (const targetId of new Set(
    repoReadoptions.flatMap(({ oldTargetId, newTargetId }) => [oldTargetId, newTargetId])
  )) {
    rotateSshProviderAuthority(targetId)
  }
  const win = getCurrentMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('repos:changed')
  }
  return repoReadoptions
}

// Why: generations, provisioning, the server fence and the runtime ladder cache are main-owned;
// a renderer must not forge them.
function omitRendererSshTargetGeneration<
  T extends {
    generation?: unknown
    orcadProvisioning?: unknown
    orcadFence?: unknown
    managedServerUnavailable?: unknown
    managedServerMoveOffered?: unknown
    managedServerUpdateFailure?: unknown
    remoteRuntimeResolution?: unknown
  }
>(
  value: T
): Omit<
  T,
  | 'generation'
  | 'orcadProvisioning'
  | 'orcadFence'
  | 'managedServerUnavailable'
  | 'managedServerMoveOffered'
  | 'managedServerUpdateFailure'
  | 'remoteRuntimeResolution'
> {
  const {
    generation: _generation,
    orcadProvisioning: _orcadProvisioning,
    orcadFence: _orcadFence,
    managedServerUnavailable: _managedServerUnavailable,
    managedServerMoveOffered: _managedServerMoveOffered,
    managedServerUpdateFailure: _managedServerUpdateFailure,
    remoteRuntimeResolution: _remoteRuntimeResolution,
    ...rest
  } = value
  return rest
}

function assertNotRuntimeOwned(targetId: string, action: string): void {
  const target = getSshTargetRegistryStore()!.getTarget(targetId)
  if (target && isRuntimeOwnedSshTarget(target)) {
    throw new Error(`Managed runtime SSH targets cannot be ${action} from SSH settings.`)
  }
}

/** Removing a managed host would strand its server; Stop removes both and proves the exit. */
function assertNotManagedServerHost(targetId: string): void {
  const target = getSshTargetRegistryStore()!.getTarget(targetId)
  if (target && isManagedOrcadSshTarget(target)) {
    throw new Error(
      'This host runs a managed Orca server. Use Stop… under Settings › Managed servers to stop the server and remove it first.'
    )
  }
}

export function registerSshTargetCrudHandlers(): void {
  ipcMain.handle('ssh:listTargets', () => {
    return getSshTargetRegistryStore()!.listTargets()
  })

  ipcMain.handle('ssh:listRemovedTargetLabels', () => {
    return getSshTargetRegistryStore()!.listRemovedTargetLabels()
  })

  ipcMain.handle('ssh:addTarget', (_event, args: { target: SshTargetCreateInput }) => {
    const target = getSshTargetRegistryStore()!.addTarget(
      omitRendererSshTargetGeneration(args.target)
    )
    // Why: re-adding a removed host can re-adopt orphaned workspaces; refresh the renderer's repo list so they move back onto the live host.
    const repoReadoptions = takeRepoReadoptions()
    return { target, repoReadoptions }
  })

  ipcMain.handle(
    'ssh:updateTarget',
    (_event, args: { id: string; updates: SshTargetUpdateInput }) => {
      assertNotRuntimeOwned(args.id, 'edited')
      // The fence and generation are stripped, so a managed host keeps its server binding.
      const updated = getSshTargetRegistryStore()!.updateTarget(
        args.id,
        omitRendererSshTargetGeneration(args.updates)
      )
      const environmentId = getManagedOrcadFenceEnvironmentId(updated ?? undefined)
      if (environmentId) {
        // Why: the open tunnel still dials the old address; the next use redials with the new one.
        void closeOrcadManagedTunnel(environmentId).catch(() => undefined)
      }
      return updated
    }
  )

  ipcMain.handle('ssh:removeTarget', async (_event, args: { id: string }) => {
    assertNotRuntimeOwned(args.id, 'removed')
    assertNotManagedServerHost(args.id)
    await removeRegisteredSshTarget(args.id)
  })

  ipcMain.handle('ssh:importConfig', (_event, args?: { reAdopt?: boolean }) => {
    const targets = getSshTargetRegistryStore()!.importFromSshConfig(args)
    const repoReadoptions = takeRepoReadoptions()
    return { targets, repoReadoptions }
  })

  // Why: add-host dialog picks one config entry to prefill the form; does not
  // mutate the target store (bulk sync stays on Settings → Import).
  ipcMain.handle('ssh:listConfigHosts', (_event, args?: SshConfigHostListArgs) => {
    return listUserSshConfigHostSummaries(
      getSshTargetRegistryStore()!.listTargets(),
      args?.query,
      getSshTargetRegistryStore()!.listSuppressedSshConfigAliases(),
      { refresh: args?.refresh === true }
    )
  })

  ipcMain.handle('ssh:resolveConfigHost', (_event, args: { alias: string }) => {
    return resolveUserSshConfigHost(args.alias)
  })
}
