/** The managed-server actions behind both the Managed servers settings and runtime RPC. */
import {
  cancelManagedOrcadStop,
  getManagedOrcadRuntimeStatus,
  recoverManagedOrcadEnvironment,
  rollbackManagedOrcadEnvironment,
  stopManagedOrcadEnvironment,
  updateManagedOrcadEnvironment
} from '../ssh/orcad-runtime-lifecycle'
import type { ManagedServerActions } from '../runtime/managed-server-actions-registry'
import { retireRemovedRuntimeEnvironment } from './runtime-environment-removal-cleanup'

export type ManagedOrcadActionOptions = {
  getUserDataPath: () => string
  getActiveEnvironmentId: () => string | null | undefined
  invalidateTransport: (environmentId: string) => Promise<void> | void
}

export function createManagedOrcadActions(
  options: ManagedOrcadActionOptions
): ManagedServerActions {
  const userDataPath = options.getUserDataPath
  return {
    status: (selector) => getManagedOrcadRuntimeStatus(userDataPath(), selector),
    update: async (selector, force) => {
      const result = await updateManagedOrcadEnvironment(userDataPath(), { selector, force })
      // Why: a restarted orcad drops the old connection; reconnect on the new one.
      if (result.outcome === 'updated') {
        await options.invalidateTransport(result.environment.id)
      }
      return result
    },
    rollback: async (selector) => {
      const result = await rollbackManagedOrcadEnvironment(userDataPath(), { selector })
      if (result.outcome === 'rolled-back') {
        await options.invalidateTransport(result.environment.id)
      }
      return result
    },
    recover: async (selector, acceptChangedState) => {
      const result = await recoverManagedOrcadEnvironment(userDataPath(), {
        selector,
        acceptChangedState: acceptChangedState === true
      })
      if (result.outcome === 'recovered' && result.activeVersion) {
        await options.invalidateTransport(result.environment.id)
      }
      return result
    },
    stop: (selector) =>
      stopManagedOrcadEnvironment(
        userDataPath(),
        { selector },
        {
          isActiveEnvironment: (environmentId) =>
            options.getActiveEnvironmentId() === environmentId,
          retireLocalState: (environmentId) =>
            retireRemovedRuntimeEnvironment(environmentId, options.invalidateTransport)
        }
      ),
    cancelStop: (selector) => cancelManagedOrcadStop(userDataPath(), { selector })
  }
}
