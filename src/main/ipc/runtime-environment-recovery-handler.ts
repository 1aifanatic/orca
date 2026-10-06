import { ipcMain } from 'electron'
import { retryRemoteRuntimeSharedControlConnectionsNow } from './runtime-environment-request-connections'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'
import { resumeParkedPairedRuntimeBrowserClientHosts } from '../browser/paired-runtime-browser-client-host-runtime'

const RETRY_CONNECTIONS_NOW_CHANNEL = 'runtimeEnvironments:retryConnectionsNow'

export function registerRuntimeEnvironmentRecoveryHandler(): void {
  ipcMain.removeHandler(RETRY_CONNECTIONS_NOW_CHANNEL)
  ipcMain.handle(RETRY_CONNECTIONS_NOW_CHANNEL, () => {
    retryRemoteRuntimeSharedControlConnectionsNow()
    // Online, wake, and the user opening or retrying a client-hosted tab all land here.
    void resumeParkedPairedRuntimeBrowserClientHosts(
      (environmentId) => !isRuntimeEnvironmentManuallyDisconnected(environmentId)
    )
  })
}
