import { getAppEnvironment } from '../../../../shared/app-environment'
import { isAgentStatusHooksEnabledForAgent } from '../../../agent-hooks/agent-status-hooks-setting'
import { prepareManagedCodexHomeBeforeShellLaunch } from '../../../codex/managed-home-shell-preflight'
import { prepareManagedWslCodexHomeBeforeShellLaunch } from '../../../codex/managed-wsl-home-shell-preflight'
import { defineMethod } from '../core'
import {
  PrepareCodexForPaneParams,
  PrepareCodexForWslPaneParams
} from '../../../../shared/rpc-contract/agent-hooks-params'

export const AGENT_HOOK_METHODS = [
  defineMethod({
    name: 'agentHooks.prepareCodexForWslPane',
    params: PrepareCodexForWslPaneParams,
    handler: async (params, { runtime, clientKind }) => {
      if (clientKind !== undefined) {
        throw new Error('Codex hook preparation is only available to the local Orca CLI.')
      }
      return await prepareManagedWslCodexHomeBeforeShellLaunch({
        env: {
          CODEX_HOME: params.codexHome,
          ORCA_CODEX_HOME: params.orcaCodexHome,
          WSL_DISTRO_NAME: params.wslDistro
        },
        hooksEnabled: isAgentStatusHooksEnabledForAgent(runtime.getClientSettings(), 'codex')
      })
    }
  }),
  // Why here: a pane's shell can run under the real HOME (login(1)), so only
  // the app, with its own HOME and userData, may write a Codex home for it.
  defineMethod({
    name: 'agentHooks.prepareCodexForPane',
    params: PrepareCodexForPaneParams,
    handler: async (params, { runtime, clientKind }) => {
      if (clientKind !== undefined) {
        throw new Error('Codex hook preparation is only available to the local Orca CLI.')
      }
      return await prepareManagedCodexHomeBeforeShellLaunch({
        env: { CODEX_HOME: params.codexHome, ORCA_CODEX_HOME: params.orcaCodexHome },
        userDataPath: getAppEnvironment().getPath('userData'),
        hooksEnabled: isAgentStatusHooksEnabledForAgent(runtime.getClientSettings(), 'codex')
      })
    }
  })
]
