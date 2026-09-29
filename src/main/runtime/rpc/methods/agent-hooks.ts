import { isAbsolute } from 'node:path'
import { prepareManagedWslCodexHomeBeforeShellLaunch } from '../../../codex/managed-wsl-home-shell-preflight'
import { defineMethod } from '../core'
import {
  CodexTerminalLaunchCapabilityParams,
  PrepareCodexForWslPaneParams
} from '../../../../shared/rpc-contract/agent-hooks-params'
import { codexExecutableCapability } from '../../../codex/codex-native-terminal-capability'
import { getActiveMultiplexer } from '../../../ssh/ssh-target-registry'
import { supportsWslCodexNoDaemon } from '../../../codex/codex-wsl-terminal-capability'

export const AGENT_HOOK_METHODS = [
  defineMethod({
    name: 'agentHooks.codexTerminalLaunchCapability',
    params: CodexTerminalLaunchCapabilityParams,
    handler: async (params, { runtime, clientKind }) => {
      if (clientKind !== undefined) {
        return { supported: false }
      }
      const context = runtime.resolveTerminalContext(params.terminalHandle)
      if (!context) {
        return { supported: false }
      }
      if (context.connectionId) {
        const mux = getActiveMultiplexer(context.connectionId)
        if (!mux || mux.isDisposed()) {
          return { supported: false }
        }
        return await mux.request('preflight.codexTerminalLaunchCapability', {
          executablePath: params.executablePath,
          ...(params.wslDistro ? { wslDistro: params.wslDistro } : {})
        })
      }
      if (!params.wslDistro && !isAbsolute(params.executablePath)) {
        return { supported: false }
      }
      return {
        supported: params.wslDistro
          ? await supportsWslCodexNoDaemon(params.executablePath, params.wslDistro)
          : await codexExecutableCapability.supportsNoDaemon(params.executablePath)
      }
    }
  }),
  defineMethod({
    name: 'agentHooks.prepareCodexForWslPane',
    params: PrepareCodexForWslPaneParams,
    handler: async (params, { runtime, clientKind }) => {
      if (clientKind !== undefined) {
        throw new Error('Codex hook preparation is only available to the local Orca CLI.')
      }
      const settings = runtime.getClientSettings()
      return await prepareManagedWslCodexHomeBeforeShellLaunch({
        env: {
          CODEX_HOME: params.codexHome,
          ORCA_CODEX_HOME: params.orcaCodexHome,
          WSL_DISTRO_NAME: params.wslDistro
        },
        hooksEnabled:
          settings.agentStatusHooksEnabled && !settings.disabledTuiAgents.includes('codex')
      })
    }
  })
]
