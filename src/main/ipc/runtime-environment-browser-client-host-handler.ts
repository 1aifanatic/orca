import { ipcMain } from 'electron'
import {
  BrowserClientHostPlacementPreparationRequest,
  type BrowserPageCreationPlacement
} from '../../shared/browser-client-host-placement'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import {
  closePairedRuntimeBrowserClientHostEnvironment,
  resumeParkedPairedRuntimeBrowserClientHosts,
  startPairedRuntimeBrowserClientHost
} from '../browser/paired-runtime-browser-client-host-runtime'
import { prepareBrowserClientHostPlacement } from '../browser/browser-client-host-placement-preparation'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-connectivity-handlers'
import { getRuntimeEnvironmentStatus } from './runtime-environment-transport-routing'
import { onRemoteRuntimeSharedControlReady } from './runtime-environment-shared-control-ready'

let releaseSharedControlReadyListener: (() => void) | null = null

export function registerRuntimeEnvironmentBrowserClientHostHandler(options: {
  getUserDataPath: () => string
  getSettings: () => Pick<GlobalSettings, 'browserClientHostedRemoteEnabled'>
}): void {
  releaseSharedControlReadyListener?.()
  releaseSharedControlReadyListener = onRemoteRuntimeSharedControlReady((environmentId) => {
    void resumeParkedPairedRuntimeBrowserClientHosts(environmentId)
  })
  // The user opening a client-hosted tab is always allowed to ask for one re-attach.
  ipcMain.handle('runtimeEnvironments:resumeBrowserClientHost', async (_event, input: unknown) => {
    if (typeof input !== 'string' || input.length === 0) {
      throw new Error('runtime_environment_id_required')
    }
    if (!isRuntimeEnvironmentManuallyDisconnected(input)) {
      await resumeParkedPairedRuntimeBrowserClientHosts(input)
    }
  })
  ipcMain.handle(
    'runtimeEnvironments:prepareBrowserClientHostPlacement',
    async (_event, input: unknown): Promise<BrowserPageCreationPlacement> => {
      const args = BrowserClientHostPlacementPreparationRequest.parse(input)
      const userDataPath = options.getUserDataPath()
      const initialEnvironment = resolveEnvironment(userDataPath, args.selector)
      requireConnected(initialEnvironment.id)
      const placement = await prepareBrowserClientHostPlacement({
        selector: initialEnvironment.id,
        expectedPairingRevision: args.expectedPairingRevision,
        preference: args.preference,
        enabled: options.getSettings().browserClientHostedRemoteEnabled !== false,
        resolveEnvironment: (selector) => resolveEnvironment(userDataPath, selector),
        getStatus: async (environmentId) => {
          requireConnected(environmentId)
          const status = await getRuntimeEnvironmentStatus(userDataPath, environmentId, undefined, {
            observeOnly: true
          })
          requireConnected(environmentId)
          return status
        },
        startHost: startPairedRuntimeBrowserClientHost,
        closeHost: closePairedRuntimeBrowserClientHostEnvironment
      })
      if (placement.kind === 'client') {
        try {
          requireConnected(initialEnvironment.id)
        } catch (error) {
          const reason = error instanceof Error ? error : new Error(String(error))
          await closePairedRuntimeBrowserClientHostEnvironment(initialEnvironment.id, reason).catch(
            () => false
          )
          throw reason
        }
      }
      return placement
    }
  )
}

function requireConnected(environmentId: string): void {
  if (isRuntimeEnvironmentManuallyDisconnected(environmentId)) {
    throw new Error('runtime_manually_disconnected')
  }
}
