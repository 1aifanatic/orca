import { defineMethod, type RpcContext } from '../../core'
import type { PluginFrameEntry } from '../../../../../shared/plugins/frames/plugin-frame-bridge'
import { listPluginsForClients } from '../../../../plugins/discovery/plugin-client-list'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import type { PluginService } from '../../../../plugins/plugin-service'
import type { PluginConsentRequest } from '../../../../../shared/plugins/approval/plugin-consent-request'
import {
  PluginDevInspectParams,
  PluginDevLoadParams,
  PluginDevUnloadParams,
  PluginGetLogsParams,
  PluginInvokeCommandParams,
  PluginReadPanelEntryParams,
  PluginRestartParams,
  PluginRpcConsentParams,
  PluginSetEnabledParams,
  PluginSetSystemEnabledParams,
  PluginsPanelActionParams
} from '../../../../../shared/rpc-contract/plugins/plugins-params'
import {
  approvePluginFromCli,
  pluginCliApprovalRequest
} from '../../../../plugins/cli/plugin-cli-approval'
import { PluginApprovalRequiredError } from '../../../../../shared/plugins/approval/plugin-cli-approval'
import {
  loadPluginDevFolder,
  unloadPluginDevFolder
} from '../../../../plugins/development/plugin-dev-folders'

import {
  getPluginServiceForRpc,
  getPluginServiceWritesForRpc,
  setPluginServiceForRpc
} from './plugin-rpc-slots'

export { setPluginServiceForRpc }

/** Expose desktop IPC's plugin consent/actions over serve/headless RPC through the same PluginService permission boundary. */

export function requirePluginService(): PluginService {
  const service = getPluginServiceForRpc()
  if (!service) {
    throw new Error('Plugin service is not available on this runtime')
  }
  return service
}

function requireConsentWrite(): (request: PluginConsentRequest) => Promise<void> {
  const applyConsent = getPluginServiceWritesForRpc()?.applyConsent
  if (!applyConsent) {
    throw new Error('Plugin consent is not available on this runtime')
  }
  return applyConsent
}

function requireDevPathsWrite(): (paths: string[]) => void {
  const setDevPluginPaths = getPluginServiceWritesForRpc()?.setDevPluginPaths
  if (!setDevPluginPaths) {
    throw new Error('Plugin development folders are not available on this runtime')
  }
  return setDevPluginPaths
}

async function listEntryForRpc(pluginKey: string | null): Promise<PluginHostListEntry | null> {
  return pluginKey === null
    ? null
    : ((await listForRpc()).find((entry) => entry.pluginKey === pluginKey) ?? null)
}

async function listForRpc(): Promise<PluginHostListEntry[]> {
  return listPluginsForClients(requirePluginService())
}

function rpcPanelOwner(context: RpcContext): string {
  // Bind bearer sessions to individual paired connections, even for sibling sockets of one device.
  return `runtime:${context.connectionId ?? context.clientId ?? 'local'}`
}

function bindRpcPanelOwner(service: PluginService, context: RpcContext): string {
  const ownerKey = rpcPanelOwner(context)
  service.panels.bindOwnerSignal(ownerKey, context.signal)
  return ownerKey
}

export const PLUGIN_METHODS = [
  defineMethod({
    name: 'plugins.list',
    permission: 'workspace',
    params: null,
    handler: async () => listForRpc()
  }),
  defineMethod({
    // Why the flag even for paired callers: an agent CLI reaches serve as a paired device too, so
    // no transport proves a person clicked; only the fingerprint from `approval_required` grants.
    name: 'plugins.consent',
    permission: 'host-admin',
    params: PluginRpcConsentParams,
    handler: async (params, context) => {
      const service = requirePluginService()
      await service.whenReady()
      const applyConsent = requireConsentWrite()
      if (params.decision === 'keep-disabled') {
        await applyConsent({
          pluginKey: params.pluginKey,
          reviewedFingerprint: params.reviewedFingerprint ?? '',
          decision: 'keep-disabled'
        })
        return listForRpc()
      }
      const plugin = service.findValidPlugin(params.pluginKey)
      if (
        plugin &&
        params.reviewedFingerprint !== undefined &&
        params.reviewedFingerprint !== plugin.consentFingerprint
      ) {
        throw new PluginApprovalRequiredError(pluginCliApprovalRequest(plugin, 'enable'), true)
      }
      await approvePluginFromCli({
        service,
        applyConsent,
        pluginKey: params.pluginKey,
        approvalFingerprint: params.approvalFingerprint,
        action: 'enable',
        caller: context.caller
      })
      return listForRpc()
    }
  }),
  defineMethod({
    name: 'plugins.setEnabled',
    permission: 'host-admin',
    params: PluginSetEnabledParams,
    handler: async (params, context) => {
      const service = requirePluginService()
      await service.whenReady()
      const applyEnablement = getPluginServiceWritesForRpc()?.applyEnablement
      if (!applyEnablement) {
        throw new Error('Plugin enablement is not available on this runtime')
      }
      if (!params.enabled) {
        await applyEnablement(params.pluginKey, false)
        return listForRpc()
      }
      // Enabling grants whatever consent is missing, so it goes through the same approve flag.
      await approvePluginFromCli({
        service,
        applyConsent: requireConsentWrite(),
        pluginKey: params.pluginKey,
        approvalFingerprint: params.approvalFingerprint,
        action: 'enable',
        caller: context.caller
      })
      return listForRpc()
    }
  }),
  defineMethod({
    // Agent dev loop: same list Settings → Plugins edits; code stays inert without the approve flag.
    name: 'plugins.devLoad',
    permission: 'host-admin',
    params: PluginDevLoadParams,
    handler: async (params, context) => {
      const service = requirePluginService()
      await service.whenReady()
      const result = await loadPluginDevFolder({
        service,
        writes: {
          setDevPluginPaths: requireDevPathsWrite(),
          applyConsent: requireConsentWrite()
        },
        path: params.path,
        approvalFingerprint: params.approvalFingerprint,
        caller: context.caller
      })
      return { ...result, plugin: await listEntryForRpc(result.pluginKey) }
    }
  }),
  defineMethod({
    name: 'plugins.devUnload',
    permission: 'host-admin',
    params: PluginDevUnloadParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      return unloadPluginDevFolder({
        service,
        writes: { setDevPluginPaths: requireDevPathsWrite() },
        target:
          params.pluginKey !== undefined
            ? { pluginKey: params.pluginKey }
            : { path: params.path ?? '' }
      })
    }
  }),
  defineMethod({
    // Settings → Plugins' switch for windowless hosts; it approves nothing, so only approved plugins run.
    name: 'plugins.setSystemEnabled',
    permission: 'host-admin',
    params: PluginSetSystemEnabledParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      const setSystemEnabled = getPluginServiceWritesForRpc()?.setPluginSystemEnabled
      if (!setSystemEnabled) {
        throw new Error('Turning plugins on or off is not available on this runtime')
      }
      setSystemEnabled(params.enabled)
      // The settings listener's refresh only logs failures; awaiting a chained one surfaces them.
      await service.refresh()
      return { enabled: params.enabled, plugins: await listForRpc() }
    }
  }),
  defineMethod({
    name: 'plugins.devInspect',
    permission: 'host-admin',
    params: PluginDevInspectParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      const openFrameDevTools = getPluginServiceWritesForRpc()?.openFrameDevTools
      if (!openFrameDevTools) {
        throw new Error('Plugin frame DevTools are only available in the Orca desktop app')
      }
      return { pluginKey: params.pluginKey, opened: openFrameDevTools(params.pluginKey) }
    }
  }),
  defineMethod({
    name: 'plugins.refresh',
    permission: 'host-admin',
    params: null,
    handler: async () => {
      const service = requirePluginService()
      await service.whenReady()
      await service.refresh()
      return listForRpc()
    }
  }),
  defineMethod({
    name: 'plugins.restart',
    permission: 'host-admin',
    params: PluginRestartParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      const plugin = service.findValidPlugin(params.pluginKey)
      if (!plugin) {
        throw new Error(`plugin ${params.pluginKey} is not installed or loaded`)
      }
      if (!plugin.manifest.main) {
        throw new Error(`plugin ${params.pluginKey} has no worker to restart`)
      }
      // Why stop only: workers start on their next command or event, so that run loads fresh code.
      await service.deactivatePlugin(params.pluginKey)
      return { pluginKey: params.pluginKey, plugin: await listEntryForRpc(params.pluginKey) }
    }
  }),
  defineMethod({
    name: 'plugins.getLogs',
    permission: 'host-admin',
    params: PluginGetLogsParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      // Why `cursor` even without `after`: `orca plugin dev watch` takes a baseline, then follows.
      const { lines, cursor } = service.getLogsSince(params.pluginKey, params.after)
      return { pluginKey: params.pluginKey, lines, cursor }
    }
  }),
  defineMethod({
    // Enforce panel capabilities here too because headless clients relay bridge calls over RPC.
    name: 'plugins.panelAction',
    permission: 'host-admin',
    // Apply raw admission before strict parsing so malformed/oversize traffic still consumes panel budget.
    params: PluginsPanelActionParams,
    handler: async (params, context) => {
      const service = requirePluginService()
      await service.whenReady()
      return {
        outcome: await service.panels.execute(bindRpcPanelOwner(service, context), params)
      }
    }
  }),
  defineMethod({
    name: 'plugins.readPanelEntry',
    permission: 'workspace',
    params: PluginReadPanelEntryParams,
    handler: async (params, context): Promise<PluginFrameEntry | null> => {
      const service = requirePluginService()
      await service.whenReady()
      const ownerKey = bindRpcPanelOwner(service, context)
      const entry = await service.panels.open(ownerKey, params.pluginKey, params.panelId)
      if (context.signal?.aborted) {
        service.panels.revokeOwner(ownerKey)
        return null
      }
      return entry
    }
  }),
  defineMethod({
    name: 'plugins.invokeCommand',
    permission: 'host-admin',
    params: PluginInvokeCommandParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      return service.invokeCommand(params.pluginKey, params.commandId, params.args)
    }
  })
]
