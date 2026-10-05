import { afterEach, describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_TAB_LAUNCH_PRESENTATION_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { writeDefaultSessionViewState } from '../storage/default-session-view-state'
import {
  agentLaunchCreateParams,
  agentLaunchExistingParams,
  phoneLaunchViewMode,
  readAgentLaunchSupport
} from './agent-launch-request'
import { createWorktreeWithNameRetry } from './worktree-create-retry'

const CAPABLE = [AGENT_LAUNCH_RUNTIME_CAPABILITY, AGENT_TAB_LAUNCH_PRESENTATION_RUNTIME_CAPABILITY]

afterEach(() => {
  writeDefaultSessionViewState(null)
})

describe("the phone's launch starting view", () => {
  it("sends the phone's loaded default to a host that stamps it", () => {
    writeDefaultSessionViewState({ value: 'chat', settled: true })
    expect(phoneLaunchViewMode(CAPABLE)).toBe('chat')
    writeDefaultSessionViewState({ value: 'terminal', settled: true })
    expect(phoneLaunchViewMode(CAPABLE)).toBe('terminal')
  })

  it('sends nothing while the default store has not loaded, so the host default applies', () => {
    expect(phoneLaunchViewMode(CAPABLE)).toBeUndefined()
    writeDefaultSessionViewState({ value: 'terminal', settled: false })
    expect(phoneLaunchViewMode(CAPABLE)).toBeUndefined()
  })

  it('sends nothing to a host without launch-presentation stamping', () => {
    writeDefaultSessionViewState({ value: 'chat', settled: true })
    expect(phoneLaunchViewMode([AGENT_LAUNCH_RUNTIME_CAPABILITY])).toBeUndefined()
  })

  it('reads the capability into the launch support', () => {
    expect(readAgentLaunchSupport([AGENT_LAUNCH_RUNTIME_CAPABILITY])).toEqual({ replay: false })
    expect(readAgentLaunchSupport(CAPABLE)).toEqual({ replay: false, launchPresentation: true })
  })

  it('puts the view on both launch builders only when given one', () => {
    expect(
      agentLaunchCreateParams('claude', { repo: 'id:r', name: 'n' }, null, 'chat')
    ).toMatchObject({ viewMode: 'chat' })
    expect(agentLaunchCreateParams('claude', { repo: 'id:r', name: 'n' })).not.toHaveProperty(
      'viewMode'
    )
    expect(
      agentLaunchExistingParams({
        agent: 'claude',
        worktreeId: 'wt',
        operationId: 'op',
        viewMode: 'terminal'
      })
    ).toMatchObject({ viewMode: 'terminal' })
  })
})

describe('a phone workspace create with an agent', () => {
  it('freezes the view before the first create, so a retry never re-reads a changed default', async () => {
    writeDefaultSessionViewState({ value: 'chat', settled: true })
    const sent: Array<Record<string, unknown>> = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create reaches only these four client members.
    const client = {
      getState: () => 'connected',
      getLastInboundAt: () => null,
      onStateChange: () => () => {},
      sendRequest: async (_method: string, params?: unknown) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create sends a params object.
        sent.push(params as Record<string, unknown>)
        if (sent.length === 1) {
          // The user flips the default while the first attempt is in flight.
          writeDefaultSessionViewState({ value: 'terminal', settled: true })
          return {
            id: '1',
            ok: false,
            error: { code: 'x', message: 'already exists locally' },
            _meta: { runtimeId: 'r' }
          }
        }
        return { id: '2', ok: true, result: { worktreeId: 'wt-1' }, _meta: { runtimeId: 'r' } }
      }
    } as unknown as RpcClient

    const result = await createWorktreeWithNameRetry({
      client,
      baseName: 'topic',
      buildParams: (name) => ({ repo: 'id:r', name }),
      worktreeCreateIdempotency: false,
      agentLaunch: { agent: 'claude', supported: { replay: false, launchPresentation: true } }
    })

    expect(result).toMatchObject({ worktreeId: 'wt-1' })
    expect(sent.map((params) => params.viewMode)).toEqual(['chat', 'chat'])
  })
})
