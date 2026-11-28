import type { Store } from '../../../../persistence/loading-store/store'
import type { PluginConsentRequest } from '../../../../../shared/plugins/approval/plugin-consent-request'
import type { PluginService } from '../../../../plugins/plugin-service'
import type { PluginCliCatalogs } from '../../../../plugins/cli/plugin-cli-catalog-candidates'
import type { PluginViewDesktop } from '../../../../plugins/view/plugin-view-desktop'

export type PluginServiceRpcWrites = {
  applyConsent: (request: PluginConsentRequest) => Promise<void>
  applyEnablement: (pluginKey: string, enabled: boolean) => Promise<void>
  setDevPluginPaths?: (paths: string[]) => void
  setPluginSystemEnabled?: (enabled: boolean) => void
  openFrameDevTools?: (pluginKey: string) => number
}

/** What install, update, uninstall and catalog RPCs need beyond the plugin service. */
export type PluginInstallRpcServices = {
  pluginService: PluginService
  catalogs: PluginCliCatalogs
  applyConsent: (request: PluginConsentRequest) => Promise<void>
  store: Pick<Store, 'getSettings' | 'updateSettings'>
  afterUninstall?: (pluginKey: string) => Promise<void>
}

export type PluginViewRpcSource = PluginViewDesktop | (() => Promise<PluginViewDesktop>)

let pluginServiceForRpc: PluginService | null = null
let pluginServiceWritesForRpc: PluginServiceRpcWrites | null = null
let installServicesForRpc: PluginInstallRpcServices | null = null
let pluginViewSourceForRpc: PluginViewRpcSource | null = null
let pluginViewPromiseForRpc: Promise<PluginViewDesktop> | null = null

export function setPluginServiceForRpc(
  service: PluginService | null,
  writes?: PluginServiceRpcWrites
): void {
  pluginServiceForRpc = service
  pluginServiceWritesForRpc = writes ?? null
}

export function getPluginServiceForRpc(): PluginService | null {
  return pluginServiceForRpc
}

export function getPluginServiceWritesForRpc(): PluginServiceRpcWrites | null {
  return pluginServiceWritesForRpc
}

export function setPluginInstallServicesForRpc(services: PluginInstallRpcServices | null): void {
  installServicesForRpc = services
}

export function getPluginInstallServicesForRpc(): PluginInstallRpcServices | null {
  return installServicesForRpc
}

export function setPluginViewForRpc(view: PluginViewRpcSource | null): void {
  pluginViewSourceForRpc = view
  pluginViewPromiseForRpc = null
}

export function resolvePluginViewForRpc(): Promise<PluginViewDesktop | null> {
  const source = pluginViewSourceForRpc
  if (!source) {
    return Promise.resolve(null)
  }
  if (typeof source !== 'function') {
    return Promise.resolve(source)
  }
  if (!pluginViewPromiseForRpc) {
    const loading = source().catch((error) => {
      if (pluginViewPromiseForRpc === loading) {
        pluginViewPromiseForRpc = null
      }
      throw error
    })
    pluginViewPromiseForRpc = loading
  }
  return pluginViewPromiseForRpc
}
