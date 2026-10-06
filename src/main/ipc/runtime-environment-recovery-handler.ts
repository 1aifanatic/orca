import { ipcMain } from 'electron'
import { retryRemoteRuntimeSharedControlConnectionsNow } from './runtime-environment-request-connections'
import { resumeParkedPairedRuntimeBrowserClientHosts } from '../browser/paired-runtime-browser-client-host-runtime'

const RETRY_CONNECTIONS_NOW_CHANNEL = 'runtimeEnvironments:retryConnectionsNow'

export function registerRuntimeEnvironmentRecoveryHandler(): void {
  ipcMain.removeHandler(RETRY_CONNECTIONS_NOW_CHANNEL)
  ipcMain.handle(RETRY_CONNECTIONS_NOW_CHANNEL, () => {
    retryRemoteRuntimeSharedControlConnectionsNow()
    // Why also here: a control connection that never noticed the outage will not report "ready".
    void resumeParkedPairedRuntimeBrowserClientHosts()
  })
}
