import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type { AgentModelCatalogSuccess } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type * as CatalogStoreModule from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  agentModelCatalogStore,
  AGENT_MODEL_CATALOG_FRESH_MS
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogFingerprint } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { claudeAndCodexAgents } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'
import { modelCatalogHostDeps } from './structured-agent-model-catalog-wiring'

const clock = vi.hoisted(() => ({ now: 1_000 }))
vi.mock('../native-chat/agent-model-catalog/agent-model-catalog-store', async (importOriginal) => {
  const actual = await importOriginal<typeof CatalogStoreModule>()
  return {
    ...actual,
    agentModelCatalogStore: new actual.AgentModelCatalogStore({ now: () => clock.now })
  }
})

const SAVED_MODEL = {
  id: 'sonnet',
  label: 'Remembered model',
  description: 'Remembered description',
  isDefault: true,
  efforts: [
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' }
  ],
  defaultEffort: 'high',
  supportsFastMode: false
}

let nextAccount = 0
async function hostCatalog(input: {
  agent?: 'claude' | 'codex'
  origin?: AgentModelCatalogSuccess['origin']
  stale?: boolean
  session?: boolean
  model?: string
  fastSupported?: boolean
}) {
  const agent = input.agent ?? 'claude'
  const home = {
    variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
    path: `/accounts/catalog-test-${++nextAccount}`
  }
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({ claimStatus: 'released', ownerProcess: null })
  )
  record.provider = agent
  record.accountHome = home
  record.location.workspaceKind = 'folder'
  record.options = input.model ? { model: input.model } : {}
  const fingerprint = agentModelCatalogFingerprint({ agent, accountHome: home, wslDistro: null })
  const saved: AgentModelCatalogSuccess = {
    models: [{ ...SAVED_MODEL, supportsFastMode: input.fastSupported ?? false }],
    fastModeSupport: { supported: input.fastSupported ?? false },
    fastModeTierByModel: new Map(),
    origin: input.origin ?? 'probe'
  }
  agentModelCatalogStore.recordSuccess(fingerprint, agent, saved)
  const fetchedAt = clock.now
  if (input.stale) {
    clock.now += AGENT_MODEL_CATALOG_FRESH_MS
    const failedProbe = async () => {
      throw new Error('temporarily unavailable')
    }
    await agentModelCatalogStore.refresh(fingerprint, agent, failedProbe, failedProbe)
    expect(agentModelCatalogStore.hasActiveFailure(fingerprint)).toBe(true)
  }
  vi.spyOn(agentModelCatalogStore, 'attachPersistence').mockResolvedValue()
  const resolveEnvironment = vi.fn(async () => {
    throw new Error('a saved catalog read must not launch an agent')
  })
  const { modelCatalog } = await modelCatalogHostDeps({
    store: { getRecord: () => (input.session ? record : null) },
    agents: claudeAndCodexAgents(),
    deps: {
      stateDirectory: '/unused/catalog-test-state',
      resolveAgentAccountHome: async () => home,
      resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true })
    },
    envResolvers: {
      resolveCodexEnvironment: resolveEnvironment,
      resolveClaudeInheritedEnv: resolveEnvironment
    }
  })
  if (!modelCatalog) {
    throw new Error('the host has a catalog service')
  }
  const result = await modelCatalog.read({
    agent,
    ...(input.session ? { sessionId: record.sessionId } : {})
  })
  expect(resolveEnvironment).not.toHaveBeenCalled()
  return { result, record, saved, fetchedAt, fingerprint }
}

afterEach(() => vi.restoreAllMocks())

describe('the runtime host catalog for session pickers', () => {
  it.each([
    ['probe', false],
    ['probe', true],
    ['live-session', false],
    ['live-session', true]
  ] as const)(
    'treats %s rows as remembered choices at any age (stale: %s)',
    async (origin, stale) => {
      const { result, saved, fetchedAt, fingerprint } = await hostCatalog({ origin, stale })
      expect(result).toMatchObject({
        origin,
        fetchedAt,
        models: [
          {
            id: SAVED_MODEL.id,
            label: SAVED_MODEL.label,
            description: SAVED_MODEL.description,
            isDefault: false,
            efforts: expect.arrayContaining([{ value: 'xhigh', label: 'Extra high' }])
          }
        ]
      })
      expect(result).not.toHaveProperty('fastModeSupport')
      if (result.origin === 'unknown') {
        throw new Error('a saved catalog remains available')
      }
      expect(result.models[0]).not.toHaveProperty('defaultEffort')
      expect(result.models[0]).not.toHaveProperty('supportsFastMode')
      expect(agentModelCatalogStore.get(fingerprint)?.models).toEqual(saved.models)
    }
  )

  it.each([false, true])(
    'drops saved Fast claims in either direction (supported: %s)',
    async (fastSupported) => {
      const { result } = await hostCatalog({ fastSupported })
      expect(result).not.toHaveProperty('fastModeSupport')
      if (result.origin === 'unknown') {
        throw new Error('a saved catalog remains available')
      }
      expect(result.models[0]).not.toHaveProperty('supportsFastMode')
    }
  )

  it.each(['sonnet', 'new-current-model'])(
    'keeps names usable and adds a permissive row for a pinned folder session model %s',
    async (model) => {
      const { result, record } = await hostCatalog({ session: true, model, stale: true })
      if (result.origin === 'unknown') {
        throw new Error('the pinned account has a saved catalog')
      }
      expect(result.models).toContainEqual(
        expect.objectContaining({
          id: SAVED_MODEL.id,
          label: SAVED_MODEL.label
        })
      )
      const current = result.models.find((row) => row.id === model)
      expect(current).toMatchObject({
        isDefault: false,
        efforts: expect.arrayContaining([{ value: 'xhigh', label: 'Extra high' }])
      })
      expect(current).not.toHaveProperty('defaultEffort')
      expect(current).not.toHaveProperty('supportsFastMode')
      expect(record.options).toEqual({ model })
      expect(result).not.toHaveProperty('current')
    }
  )

  it('preserves the existing Codex catalog default and capability policy', async () => {
    const { result, saved, fetchedAt } = await hostCatalog({ agent: 'codex', stale: true })
    expect(result).toEqual({
      origin: saved.origin,
      models: saved.models,
      fastModeSupport: saved.fastModeSupport,
      fetchedAt
    })
  })
})
