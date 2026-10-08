import { defineMethod } from '../core'
import { CodexMaintenanceRequest } from '../../../../shared/codex-cli-maintenance'
import { codexMaintenanceOnHost } from '../../../preflight/codex-maintenance-host'
import {
  detectRemoteAgents,
  detectRemoteWindowsTerminalCapabilities,
  detectInstalledAgentsWithShellPathHydration,
  refreshShellPathAndDetectAgents,
  runPreflightCheck
} from '../../../preflight/agent-detection'
import {
  PreflightCheck,
  PreflightDetectRemoteAgents,
  PreflightDetectRemoteWindowsTerminalCapabilities
} from '../../../../shared/rpc-contract/preflight-params'

export const PREFLIGHT_METHODS = [
  defineMethod({
    name: 'preflight.codexMaintenance',
    permission: 'workspace',
    params: CodexMaintenanceRequest,
    handler: async (params, { runtime }) =>
      codexMaintenanceOnHost(params, runtime.getCodexMaintenanceSettings())
  }),
  defineMethod({
    name: 'preflight.check',
    permission: 'workspace',
    params: PreflightCheck,
    handler: async (params) => runPreflightCheck(params.force)
  }),
  defineMethod({
    name: 'preflight.detectAgents',
    permission: 'workspace',
    params: null,
    handler: async () => detectInstalledAgentsWithShellPathHydration()
  }),
  defineMethod({
    name: 'preflight.detectRemoteAgents',
    permission: 'workspace',
    params: PreflightDetectRemoteAgents,
    handler: async (params) => detectRemoteAgents(params)
  }),
  defineMethod({
    name: 'preflight.detectRemoteWindowsTerminalCapabilities',
    permission: 'workspace',
    params: PreflightDetectRemoteWindowsTerminalCapabilities,
    handler: async (params) => detectRemoteWindowsTerminalCapabilities(params)
  }),
  defineMethod({
    name: 'preflight.refreshAgents',
    permission: 'workspace',
    params: null,
    handler: async () => refreshShellPathAndDetectAgents()
  })
]
