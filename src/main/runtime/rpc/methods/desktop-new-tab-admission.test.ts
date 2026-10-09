import { describe, expect, it } from 'vitest'
import {
  AGENT_LAUNCH_DESKTOP_NEW_TAB_CLIENT_CAPABILITY,
  AGENT_LAUNCH_RUNTIME_CAPABILITY
} from '../../../../shared/agent-launch-runtime-capability'
import { DESKTOP_RPC_CALLER } from '../rpc-caller-identity'
import { methodNamed, rpcContext, runtimeStub } from './agent-launch.test-fixture'
import { AGENT_LAUNCH_METHODS } from './agent-launch'
import type { RpcContext } from '../core'

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
const LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
const REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')
const CAPABLE_CLIENT = [
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_DESKTOP_NEW_TAB_CLIENT_CAPABILITY
] as const
const REFUSED_CALLERS: { name: string; context: Partial<RpcContext> }[] = [
  {
    name: 'desktop without client capability',
    context: {
      caller: DESKTOP_RPC_CALLER,
      clientKind: 'runtime',
      clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
    }
  },
  {
    name: 'local CLI with client capability',
    context: { caller: { kind: 'local-cli' }, clientCapabilities: CAPABLE_CLIENT }
  },
  {
    name: 'paired mobile with client capability',
    context: {
      caller: { kind: 'paired-device', deviceId: 'mobile-test' },
      clientKind: 'mobile',
      pairedDeviceId: 'mobile-test',
      clientCapabilities: CAPABLE_CLIENT
    }
  },
  {
    name: 'paired desktop deferred until Step 5',
    context: {
      caller: { kind: 'paired-device', deviceId: 'desktop-test' },
      clientKind: 'runtime',
      pairedDeviceId: 'desktop-test',
      clientCapabilities: CAPABLE_CLIENT
    }
  }
]

describe('desktop startup admission requires client negotiation and the host desktop identity', () => {
  it('refuses unrecorded input without client capability before any side effect', async () => {
    const runtime = runtimeStub({ settings: {} })
    const method = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
    const params = method.params.parse({ ...PARAMS, operationId: undefined })
    await expect(
      method.handler(
        params,
        rpcContext(runtime, {
          caller: DESKTOP_RPC_CALLER,
          clientKind: 'runtime',
          clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
        })
      )
    ).rejects.toThrow('agent_launch_desktop_new_tab_unsupported')
    expect(runtime.showTerminalWorkspaceLaunchScope).not.toHaveBeenCalled()
    expect(runtime.publishAgentLaunchTab).not.toHaveBeenCalled()
    expect(runtime.openAgentSessionRecordStore).not.toHaveBeenCalled()
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })
  for (const name of ['agent.launch', 'agent.launchReplay'] as const) {
    for (const caller of REFUSED_CALLERS) {
      it(`${name} refuses ${caller.name} before any side effect`, async () => {
        const runtime = runtimeStub({ settings: {} })
        const context = rpcContext(runtime, caller.context)
        const pending =
          name === 'agent.launch'
            ? LAUNCH.handler(LAUNCH.params.parse(PARAMS), context)
            : REPLAY.handler(REPLAY.params.parse(PARAMS), context)
        await expect(pending).rejects.toThrow('agent_launch_desktop_new_tab_unsupported')
        expect(runtime.showTerminalWorkspaceLaunchScope).not.toHaveBeenCalled()
        expect(runtime.publishAgentLaunchTab).not.toHaveBeenCalled()
        expect(runtime.openAgentSessionRecordStore).not.toHaveBeenCalled()
        expect(runtime.createTerminal).not.toHaveBeenCalled()
        expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
        expect(runtime.getClientSettings).not.toHaveBeenCalled()
      })
    }
  }
})
