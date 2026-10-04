import { resolveEnvironment } from '../../shared/runtime-environment-store'
import type { SshManagedServerUpdateNote, SshTarget } from '../../shared/ssh-types'
import { managedServerUpdateDeps } from '../ssh/managed-server-update-deps'
import { ensureOrcadManagedTunnel } from '../ssh/orcad-managed-tunnel'
import { updateManagedOrcadOnRestore } from '../ssh/orcad-managed-update-on-restore'
import { setSshHostServerStatus } from '../ssh/ssh-host-server-status'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { connectionManager, getCurrentMainWindow } from './ssh-ipc-context'
import { broadcastSshState } from './ssh-renderer-broadcast'

export async function resolveManagedRuntimeEnvironment(
  userDataPath: string,
  selector: string
): Promise<ReturnType<typeof resolveEnvironment>> {
  const environment = resolveEnvironment(userDataPath, selector)
  await ensureOrcadManagedTunnel(userDataPath, environment.id)
  // Why here: an auto-restored host may never see an SSH connect, so it would never update.
  void updateManagedOrcadOnRestore(environment.id, () => ({
    ...managedServerUpdateDeps(userDataPath),
    target: () => {
      const targetId = environment.orcadDeployment?.sshTargetId
      return targetId ? (getSshTargetRegistryStore()?.getTarget(targetId) ?? null) : null
    },
    publish: publishRestoreUpdate
  }))
  return resolveEnvironment(userDataPath, environment.id)
}

function publishRestoreUpdate(
  target: SshTarget,
  environmentId: string,
  phase: 'updating' | 'settled',
  note?: SshManagedServerUpdateNote
): void {
  setSshHostServerStatus(
    target.id,
    phase === 'updating'
      ? { kind: 'setting-up', phase: 'updating' }
      : { kind: 'managed', environmentId, ...(note ? { update: note } : {}) }
  )
  // Only a host with a connection state has a status line to refresh.
  const state = connectionManager?.getState(target.id)
  if (state) {
    broadcastSshState(getCurrentMainWindow, target.id, state)
  }
}
