import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../shared/protocol-version'

const REGISTERED: RuntimeCapability[] = [
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
]
const SETTINGS = {
  experimentalNativeChat: true,
  openAgentTabsInChatByDefault: true,
  experimentalStructuredNativeChat: true
}

const mocks = vi.hoisted(() => {
  const state: { current: Record<string, unknown> } = { current: {} }
  return { callRuntimeRpc: vi.fn(), state }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state.current } }))
vi.mock('@/lib/worktree-runtime-owner', () => ({ getExecutionHostIdForWorktree: vi.fn() }))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: vi.fn(),
  getLocalRepoProjectExecutionRuntimeContext: vi.fn()
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => false }))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => REGISTERED,
  ensureLocalRuntimeCapabilities: async () => REGISTERED
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/lib/structured-agent-launch-settlement', () => ({}))

import { resetHostStructuredAgentsForTests } from '@/runtime/host-structured-agents'
import type { LaunchAgentInNewTabArgs } from './launch-agent-in-new-tab'
import type { AgentLaunchRouteArgs } from './agent-launch-route-input'
import {
  HOST_AGENTS_WAIT_MS,
  launchOnceHostAgentsKnown,
  routeNewTabLaunch
} from './launch-agent-in-new-tab-host-agents'

const LISTS_OPENCODE = {
  agents: ['claude', 'codex', 'opencode'].map((agent) => ({ agent, capabilities: {} }))
}
const request: AgentLaunchRouteArgs = {
  agent: 'opencode',
  workspace: { kind: 'git-worktree', repoId: 'repo-1' }
}
const args: LaunchAgentInNewTabArgs = {
  requestId: 'request-1',
  agent: 'opencode',
  worktreeId: 'wt-1'
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wait path only hands the startup plan back to its caller; nothing here reads its fields.
const startupPlan = { launchCommand: 'opencode' } as never

function useSettings(settings: Record<string, unknown>) {
  mocks.state.current = {
    settings,
    runtimeStatusByEnvironmentId: new Map(),
    worktreesByRepo: {},
    folderWorkspaces: []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the route builder reads only the settings, host statuses and workspace rows set here; a missing member reads as absent.
  return mocks.state.current as never
}

/** Stands in for the launcher re-entered with the plan decided after the wait. */
function fakeRelaunch() {
  return vi.fn((relaunched: LaunchAgentInNewTabArgs) => ({
    surface: { kind: 'host-published' as const },
    startupPlan,
    pasteDraftAfterLaunch: false,
    structuredSettlement: Promise.resolve(
      relaunched.agentSessionLaunchPlan?.route === 'structured-native-chat'
        ? { kind: 'structured' as const, sessionId: 'session-1' }
        : { kind: 'cancelled' as const, sessionId: null }
    )
  }))
}

beforeEach(() => {
  resetHostStructuredAgentsForTests()
  mocks.callRuntimeRpc.mockReset().mockResolvedValue(LISTS_OPENCODE)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a new tab whose chat route waits on the host agent list', () => {
  it('opens the chat on the first launch once the host lists the agent', async () => {
    const store = useSettings(SETTINGS)
    const route = routeNewTabLaunch(store, args, request)
    if (!('awaited' in route)) {
      throw new Error('expected the launch to wait for the host agent list')
    }
    const relaunch = fakeRelaunch()

    const result = launchOnceHostAgentsKnown(route, args, startupPlan, relaunch)

    expect(result?.surface).toEqual({ kind: 'host-published' })
    expect(relaunch).not.toHaveBeenCalled()
    await expect(result?.structuredSettlement).resolves.toEqual({
      kind: 'structured',
      sessionId: 'session-1'
    })
    expect(relaunch.mock.calls[0]?.[0]).toMatchObject({
      requestId: undefined,
      agentSessionLaunchPlan: { route: 'structured-native-chat', requestId: 'request-1' }
    })
  })

  it('decides without the list once the bounded wait runs out', async () => {
    vi.useFakeTimers()
    mocks.callRuntimeRpc.mockReturnValue(new Promise(() => {}))
    const store = useSettings(SETTINGS)
    const route = routeNewTabLaunch(store, args, request)
    if (!('awaited' in route)) {
      throw new Error('expected the launch to wait for the host agent list')
    }
    const relaunch = vi.fn((_relaunched: LaunchAgentInNewTabArgs) => ({
      surface: { kind: 'local-terminal' as const, tabId: 'tab-1' },
      startupPlan,
      pasteDraftAfterLaunch: false
    }))

    const result = launchOnceHostAgentsKnown(route, args, startupPlan, relaunch)
    await vi.advanceTimersByTimeAsync(HOST_AGENTS_WAIT_MS - 1)
    expect(relaunch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    await expect(result?.structuredSettlement).resolves.toEqual({ kind: 'terminal' })
    expect(relaunch.mock.calls[0]?.[0]).toMatchObject({
      agentSessionLaunchPlan: { route: 'legacy-native-chat' }
    })
  })

  it('does not wait once the list is learned, or when structured chat is off', async () => {
    const store = useSettings(SETTINGS)
    const first = routeNewTabLaunch(store, args, request)
    if ('awaited' in first) {
      await first.awaited
    }

    expect(routeNewTabLaunch(store, args, request)).toMatchObject({
      plan: { route: 'structured-native-chat' }
    })
    expect(
      routeNewTabLaunch(
        useSettings({ ...SETTINGS, experimentalStructuredNativeChat: false }),
        args,
        request
      )
    ).toMatchObject({ plan: { route: 'legacy-native-chat' } })
  })
})
