import { describe, expect, it } from 'vitest'
import {
  AGENT_LAUNCH_DESKTOP_NEW_TAB_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_RUNTIME_CAPABILITY
} from '../../../../shared/agent-launch-runtime-capability'
import { DESKTOP_RPC_CALLER } from '../rpc-caller-identity'
import { methodNamed, rpcContext, runtimeStub } from './agent-launch.test-fixture'
import { AGENT_LAUNCH_METHODS } from './agent-launch'

const PARAMS = {
  agent: 'claude',
  operationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
  target: { kind: 'existing', worktree: 'folder:test' },
  prompt: {
    text: 'unsubmitted',
    delivery: 'draft',
    transport: { kind: 'desktop-new-tab', promptDelivery: 'draft' }
  }
} as const

// This checkpoint deliberately refuses the incomplete guarantee before publication or admission.
describe('an unadvertised desktop startup contract cannot be admitted', () => {
  for (const name of ['agent.launch', 'agent.launchReplay'] as const) {
    it(`${name} refuses even a client advertising the new capability before any side effect`, async () => {
      const runtime = runtimeStub({ settings: {} })
      const method = methodNamed(AGENT_LAUNCH_METHODS, name)
      const params = method.params.parse(PARAMS)
      const context = rpcContext(runtime, {
        caller: DESKTOP_RPC_CALLER,
        clientKind: 'runtime',
        clientCapabilities: [
          AGENT_LAUNCH_RUNTIME_CAPABILITY,
          AGENT_LAUNCH_DESKTOP_NEW_TAB_RUNTIME_CAPABILITY
        ]
      })
      await expect(method.handler(params, context)).rejects.toThrow(
        'agent_launch_desktop_new_tab_unsupported'
      )
      expect(runtime.showTerminalWorkspaceLaunchScope).not.toHaveBeenCalled()
      expect(runtime.publishAgentLaunchTab).not.toHaveBeenCalled()
      expect(runtime.openAgentSessionRecordStore).not.toHaveBeenCalled()
      expect(runtime.createTerminal).not.toHaveBeenCalled()
    })
  }
})
