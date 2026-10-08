// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentModelCatalogStore,
  AGENT_MODEL_CATALOG_FRESH_MS
} from '../../src/main/native-chat/agent-model-catalog/agent-model-catalog-store'
import { createAgentModelCatalogService } from '../../src/main/native-chat/agent-model-catalog/agent-model-catalog-service'
import { agentModelCatalogFingerprint } from '../../src/main/native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { CLAUDE_STRUCTURED_AGENT } from '../../src/main/claude/claude-structured-agent-definition'
import { agentSessionRecordFixture } from '../../src/shared/agent-session-record.test-fixture'
import type { StructuredAgentSessionMutate } from '../../src/renderer/src/components/native-chat/use-structured-agent-session-mutate'

const mocks = vi.hoisted(() => ({ call: vi.fn(), hold: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/components/native-chat/native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))
vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: mocks.hold,
  getStructuredAgentSessionLaunchSelection: () => null
}))
import { useStructuredAgentSessionOptions } from '../../src/renderer/src/components/native-chat/use-structured-agent-session-options'

describe('Claude picker before the provider starts', () => {
  it.each([
    ['local', true, 'sonnet'],
    ['paired', true, 'sonnet'],
    ['local', false, 'sonnet'],
    ['local', true, 'unlisted-launch-model'],
    ['paired', true, 'unlisted-launch-model'],
    ['local', true, 'opus'],
    ['paired', true, 'opus'],
    ['local', false, 'opus'],
    ['paired', false, 'opus'],
    ['local', true, 'new-account-model'],
    ['paired', true, 'new-account-model'],
    ['local', false, 'new-account-model'],
    ['paired', false, 'new-account-model']
  ] as const)(
    'keeps effort choices usable on %s with saved catalog %s and launch model %s after discovery fails',
    async (host, saved, launchModel) => {
      mocks.call.mockReset()
      mocks.hold.mockReset()
      const home = { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/pinned' }
      const fingerprint = agentModelCatalogFingerprint({
        agent: 'claude',
        accountHome: home,
        wslDistro: null
      })
      let now = 1_000
      const store = new AgentModelCatalogStore({ now: () => now })
      store.recordSuccess(fingerprint, 'claude', {
        models: [
          {
            id: 'sonnet',
            label: 'Saved Sonnet',
            isDefault: true,
            efforts: [
              { value: 'low', label: 'Low' },
              { value: 'high', label: 'High' }
            ],
            defaultEffort: 'high',
            supportsFastMode: false
          }
        ],
        origin: 'probe',
        fastModeTierByModel: new Map()
      })
      now += AGENT_MODEL_CATALOG_FRESH_MS
      const probe = async () => {
        throw new Error('temporarily unavailable')
      }
      await store.refresh(fingerprint, 'claude', probe, probe)
      const record = agentSessionRecordFixture()
      record.accountHome = home
      record.options = { model: launchModel, effort: 'high' }
      const service = createAgentModelCatalogService({
        store,
        getRecord: () => (launchModel === 'unlisted-launch-model' ? record : undefined),
        drivesRecord: () => true,
        agents: { definition: () => CLAUDE_STRUCTURED_AGENT },
        resolveAccountHome: async () => home
      })
      mocks.call.mockImplementation(
        (_target: unknown, method: string, params: Parameters<typeof service.read>[0]) =>
          method === 'agentSession.modelCatalog'
            ? saved
              ? service.read(params)
              : Promise.resolve({ origin: 'unknown' })
            : new Promise(() => {})
      )
      mocks.hold.mockResolvedValue({ kind: 'held' })
      const mutate: StructuredAgentSessionMutate = vi.fn(async () => null)
      const target =
        host === 'local'
          ? { kind: 'local' as const }
          : { kind: 'environment' as const, environmentId: 'server-1' }
      const { result, unmount } = renderHook(() =>
        useStructuredAgentSessionOptions({
          agent: 'claude',
          sessionId: `starting-${host}`,
          target,
          transportEnabled: false,
          isVisible: true,
          providerVisible: false,
          providerStarting: true,
          fence: null,
          turnId: null,
          unloadedTurnRevisions: undefined,
          mutate,
          launch: {
            kind: 'new',
            seedOptions: { model: launchModel, effort: 'high' },
            heldOptions: {}
          }
        })
      )
      try {
        await waitFor(() =>
          expect(
            result.current.optionSnapshot.find((row) => row.id === 'model')?.kind
          ).toMatchObject({
            currentValue: launchModel,
            ...(saved
              ? { choices: expect.arrayContaining([{ value: 'sonnet', label: 'Saved Sonnet' }]) }
              : {})
          })
        )
        expect(
          result.current.optionSnapshot.find((row) => row.id === 'effort')?.kind
        ).toMatchObject({
          currentValue: 'high',
          choices: expect.arrayContaining([{ value: 'xhigh', label: 'Extra high' }])
        })
        let accepted = false
        await act(async () => {
          accepted = await result.current.setStructuredOption('effort', 'xhigh')
        })
        expect(accepted).toBe(true)
        expect(mocks.hold).toHaveBeenCalledExactlyOnceWith(`starting-${host}`, 'effort', 'xhigh')
        expect(mutate).not.toHaveBeenCalled()
        expect(
          mocks.call.mock.calls.every(([, method]) => method === 'agentSession.modelCatalog')
        ).toBe(true)
      } finally {
        unmount()
      }
    }
  )
})
