import { ipcMain } from 'electron'
import {
  BrowserClientHostPlacementPreparationRequest,
  type BrowserPageCreationPlacement
} from '../../shared/browser-client-host-placement'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import {
  closePairedRuntimeBrowserClientHostEnvironment,
  resumePairedRuntimeBrowserClientHost,
  startPairedRuntimeBrowserClientHost
} from '../browser/paired-runtime-browser-client-host-runtime'
import { prepareBrowserClientHostPlacement } from '../browser/browser-client-host-placement-preparation'
import { isBrowserClientHostEnvironmentParked } from '../browser/browser-client-host-parked-publication'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-connectivity-handlers'
import { getRuntimeEnvironmentStatus } from './runtime-environment-transport-routing'

export function registerRuntimeEnvironmentBrowserClientHostHandler(options: {
  getUserDataPath: () => string
  getSettings: () => Pick<GlobalSettings, 'browserClientHostedRemoteEnabled'>
}): void {
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
  // Why apart from preparation: opening a tab must not cost a status round-trip when healthy.
  ipcMain.handle(
    'runtimeEnvironments:resumeBrowserClientHost',
    async (_event, args: { selector: string }): Promise<boolean> => {
      const environment = resolveEnvironment(options.getUserDataPath(), args.selector)
      if (!isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
        await resumePairedRuntimeBrowserClientHost(environment.id)
      }
      return isBrowserClientHostEnvironmentParked(environment.id)
    }
  )
}

function requireConnected(environmentId: string): void {
  if (isRuntimeEnvironmentManuallyDisconnected(environmentId)) {
    throw new Error('runtime_manually_disconnected')
  }
}
