import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  runtimeEnvironmentSupportsCapability: vi.fn(),
  ensureLocalRuntimeCapabilities: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  showNotDelivered: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: {} }) }
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: mocks.ensureLocalRuntimeCapabilities
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  callRuntimeRpc: mocks.callRuntimeRpc,
  runtimeEnvironmentSupportsCapability: mocks.runtimeEnvironmentSupportsCapability
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, warning: mocks.toastWarning } }))
vi.mock('@/lib/agent-launch-prompt-not-delivered-notice', () => ({
  showAgentLaunchPromptNotDeliveredNotice: mocks.showNotDelivered
}))

import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'
import {
  agentLaunchTabReservationCountForTests,
  takeAgentLaunchTabReservation
} from './agent-launch-tab-reservations'
import {
  launchSourceControlAgent,
  settleSourceControlAgentLaunch,
  SOURCE_CONTROL_AGENT_LAUNCH_UNCONFIRMED_MESSAGE,
  type SourceControlAgentLaunchArgs
} from './source-control-agent-launch'
import {
  AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { parsePaneKey } from '../../../shared/stable-pane-id'

const HOST_CAPABILITIES = [
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY
]
const PROMPT = 'Fix the failing checks.\nLog tail:\nerror TS2322'
const ARGS: SourceControlAgentLaunchArgs = {
  agent: 'claude',
  worktreeId: 'wt-1',
  groupId: 'group-2',
  prompt: `  ${PROMPT}  `,
  agentArgs: '--model opus',
  launchSource: 'conflict_resolution'
}

function launchResult(prompt: Record<string, unknown> | undefined, extra = {}) {
  return {
    outcome: { kind: 'terminal', handle: 'term_1', paneKey: 'x:y' },
    worktreeId: 'wt-1',
    receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'd' },
    ...(prompt ? { prompt } : {}),
    ...extra
  }
}

function rpcRefusal(code: string, message = code): RuntimeRpcCallError {
  return new RuntimeRpcCallError({ id: 'r', ok: false, error: { code, message } })
}

function sentParams(call = 0): Record<string, unknown> {
  return mocks.callRuntimeRpc.mock.calls[call]?.[2]
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null)
  mocks.isWebRuntimeSessionActive.mockReturnValue(false)
  mocks.ensureLocalRuntimeCapabilities.mockResolvedValue(HOST_CAPABILITIES)
  mocks.callRuntimeRpc.mockResolvedValue(
    launchResult({ delivery: 'submit', outcome: 'handed-to-terminal' })
  )
})

describe('launching a source-control button’s agent through the host', () => {
  it('asks the local host for exactly this launch, replay-protected', async () => {
    await launchSourceControlAgent(ARGS)

    const [target, method, params, options] = mocks.callRuntimeRpc.mock.calls[0]!
    expect(target).toEqual({ kind: 'local' })
    expect(method).toBe('agent.launchReplay')
    expect(params).toMatchObject({
      agent: 'claude',
      target: { kind: 'existing', worktree: 'id:wt-1' },
      prompt: { text: PROMPT, delivery: 'submit' },
      agentArgs: '--model opus',
      launchSource: 'conflict_resolution'
    })
    expect(params.operationId).toMatch(/^\d+-[0-9a-f]{32}$/)
    expect(parsePaneKey(params.paneKey)).not.toBeNull()
    expect(params.sessionId).toMatch(/^claude_/)
    expect(options).toMatchObject({ timeoutMs: 90_000 })
  })

  it('sends no session id for an agent with no chat session, and passes null arguments through', async () => {
    await launchSourceControlAgent({ ...ARGS, agent: 'aider', agentArgs: null })

    expect(sentParams()).not.toHaveProperty('sessionId')
    expect(sentParams()).toHaveProperty('agentArgs', null)
  })

  it('leaves the settings arguments to the host when the button carries none', async () => {
    await launchSourceControlAgent({ ...ARGS, agentArgs: undefined })

    expect(sentParams()).not.toHaveProperty('agentArgs')
  })

  it('reserves the placement under the tab it asks for, so the reveal lands it in the button’s group', async () => {
    let placement: ReturnType<typeof takeAgentLaunchTabReservation> = null
    mocks.callRuntimeRpc.mockImplementation(async (_t, _m, params) => {
      placement = takeAgentLaunchTabReservation(parsePaneKey(params.paneKey)!.tabId, 'wt-1')
      return launchResult({ delivery: 'submit', outcome: 'handed-to-terminal' })
    })

    await launchSourceControlAgent(ARGS)

    expect(placement).toMatchObject({ worktreeId: 'wt-1', groupId: 'group-2', focus: true })
  })

  it('reports the surface accepted at the reveal, before the prompt’s delivery settles', async () => {
    const onLaunchAccepted = vi.fn()
    mocks.callRuntimeRpc.mockImplementation(async (_t, _m, params) => {
      takeAgentLaunchTabReservation(parsePaneKey(params.paneKey)!.tabId, 'wt-1')?.onRevealed?.(
        'tab'
      )
      expect(onLaunchAccepted).toHaveBeenCalledOnce()
      return launchResult({ delivery: 'submit', outcome: 'handed-to-terminal' })
    })

    await launchSourceControlAgent({ ...ARGS, onLaunchAccepted })

    expect(onLaunchAccepted).toHaveBeenCalledOnce()
  })

  it('reports it accepted on the reply when no reveal read the reservation, as for a chat', async () => {
    const onLaunchAccepted = vi.fn()

    await launchSourceControlAgent({ ...ARGS, onLaunchAccepted })

    expect(onLaunchAccepted).toHaveBeenCalledOnce()
  })

  it.each([
    ['a reply', () => launchResult({ delivery: 'submit', outcome: 'handed-to-terminal' })],
    [
      'a refusal',
      () => {
        throw rpcRefusal('invalid_argument')
      }
    ],
    [
      'a lost reply every time',
      () => {
        throw new Error('socket closed')
      }
    ]
  ])('releases the reservation after %s', async (_label, answer) => {
    mocks.callRuntimeRpc.mockImplementation(async () => answer())

    await launchSourceControlAgent(ARGS)

    expect(agentLaunchTabReservationCountForTests()).toBe(0)
  })

  it('replays a lost reply under the same operation, never as a new launch', async () => {
    mocks.callRuntimeRpc
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValueOnce(launchResult({ delivery: 'submit', outcome: 'handed-to-terminal' }))

    const result = await launchSourceControlAgent(ARGS)

    expect(result).toEqual({ kind: 'launched', promptDelivered: true })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(2)
    expect(sentParams(1)).toEqual(sentParams(0))
  })

  it('stops replaying after three sends and says the launch is unconfirmed', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(new Error('socket closed'))

    const result = await launchSourceControlAgent(ARGS)

    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(3)
    expect(result).toEqual({
      kind: 'unknown',
      message: SOURCE_CONTROL_AGENT_LAUNCH_UNCONFIRMED_MESSAGE
    })
  })

  it('treats a host that refuses the method on the first send as unsupported', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(rpcRefusal('method_not_found'))

    expect(await launchSourceControlAgent(ARGS)).toEqual({ kind: 'unsupported' })
  })

  it('treats the same refusal after a replay as unconfirmed, since the first send may have run', async () => {
    mocks.callRuntimeRpc
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockRejectedValueOnce(rpcRefusal('method_not_found'))

    expect((await launchSourceControlAgent(ARGS)).kind).toBe('unknown')
  })

  it('treats an operation the host no longer knows as unconfirmed', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(rpcRefusal('agent_session_operation_unknown'))

    expect((await launchSourceControlAgent(ARGS)).kind).toBe('unknown')
  })

  it('reports any other refusal as failed, with the host’s words', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(rpcRefusal('invalid_argument', 'Agent is disabled'))

    expect(await launchSourceControlAgent(ARGS)).toEqual({
      kind: 'failed',
      message: 'Agent is disabled'
    })
  })

  it('reports a prompt the host kept as not delivered, with the launch still started', async () => {
    mocks.callRuntimeRpc.mockResolvedValue(
      launchResult({ delivery: 'submit', outcome: 'not-delivered' }, { warning: 'Reveal failed.' })
    )

    expect(await launchSourceControlAgent(ARGS)).toEqual({
      kind: 'launched',
      promptDelivered: false,
      warning: 'Reveal failed.'
    })
  })

  it('under-claims a prompted launch whose reply carries no prompt receipt', async () => {
    mocks.callRuntimeRpc.mockResolvedValue(launchResult(undefined))

    expect(await launchSourceControlAgent(ARGS)).toEqual({
      kind: 'launched',
      promptDelivered: false
    })
  })

  it('stays on the older path while the local host has not answered its capability probe', async () => {
    mocks.ensureLocalRuntimeCapabilities.mockResolvedValue(null)

    expect(await launchSourceControlAgent(ARGS)).toEqual({ kind: 'unsupported' })
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('declines a paired host that would fold a long prompt into the typed line', async () => {
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('env-1')
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
    mocks.runtimeEnvironmentSupportsCapability.mockImplementation(
      async (_env, capability) => capability !== AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY
    )

    expect(await launchSourceControlAgent(ARGS)).toEqual({ kind: 'unsupported' })
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('launches on a capable paired host, whose own window places the tab', async () => {
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('env-1')
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
    mocks.runtimeEnvironmentSupportsCapability.mockResolvedValue(true)
    let reservations = -1
    mocks.callRuntimeRpc.mockImplementation(async () => {
      reservations = agentLaunchTabReservationCountForTests()
      return launchResult({ delivery: 'submit', outcome: 'handed-to-terminal' })
    })

    await launchSourceControlAgent(ARGS)

    expect(mocks.callRuntimeRpc.mock.calls[0]?.[0]).toEqual({
      kind: 'environment',
      environmentId: 'env-1'
    })
    expect(reservations).toBe(0)
  })

  it('runs the caller’s pre-launch step only for a host that takes the launch, and honours a no', async () => {
    const beforeLaunch = vi.fn(() => false)

    expect(await launchSourceControlAgent({ ...ARGS, beforeLaunch })).toEqual({ kind: 'aborted' })
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()

    mocks.ensureLocalRuntimeCapabilities.mockResolvedValue(null)
    beforeLaunch.mockClear()
    await launchSourceControlAgent({ ...ARGS, beforeLaunch })
    expect(beforeLaunch).not.toHaveBeenCalled()
  })
})

describe('telling the user what a hosted launch did', () => {
  it('hands over the prompt with a Copy action when the host kept it', () => {
    const settled = settleSourceControlAgentLaunch(
      { kind: 'launched', promptDelivered: false },
      { agent: 'goose', prompt: PROMPT }
    )

    expect(settled).toEqual({ started: true, promptDelivered: false, failureNotified: true })
    expect(mocks.showNotDelivered).toHaveBeenCalledWith({ agent: 'goose', prompt: PROMPT })
  })

  it('shows the host’s warning without calling the launch a failure', () => {
    const settled = settleSourceControlAgentLaunch(
      { kind: 'launched', promptDelivered: true, warning: 'Arguments were ignored.' },
      { agent: 'claude', prompt: PROMPT }
    )

    expect(settled).toEqual({ started: true, promptDelivered: true, failureNotified: false })
    expect(mocks.toastWarning).toHaveBeenCalledWith('Arguments were ignored.')
    expect(mocks.showNotDelivered).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'failed', message: 'Agent is disabled' },
    { kind: 'unknown', message: SOURCE_CONTROL_AGENT_LAUNCH_UNCONFIRMED_MESSAGE }
  ] as const)('says so once when the launch is $kind', (result) => {
    expect(settleSourceControlAgentLaunch(result, { agent: 'claude', prompt: PROMPT })).toEqual({
      started: false,
      promptDelivered: false,
      failureNotified: true
    })
    expect(mocks.toastError).toHaveBeenCalledWith(result.message)
  })
})
