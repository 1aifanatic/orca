import { describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { CLAUDE_SESSION_OPTION_CATALOG } from '../../../shared/agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionPicks,
  structuredAgentSessionOptionSnapshot
} from '../../../shared/structured-agent-session-options'
import {
  applyNativeChatSessionOptionPicks,
  resolveStructuredLaunchSeedOptions
} from '../../../shared/native-chat-session-option-defaults'
import { agentModelCatalogFingerprintForRecord } from '../agent-model-catalog/agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import {
  AGENT_MODEL_CATALOG_FRESH_MS,
  AgentModelCatalogStore
} from '../agent-model-catalog/agent-model-catalog-store'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import {
  readStructuredAgentSessionOptions,
  recordStructuredAgentSessionOptionIntent
} from './structured-agent-session-options-read'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'

const SAVED_MODEL = {
  id: 'retired-account-model',
  label: 'Saved account model',
  description: 'Saved description',
  isDefault: true,
  efforts: [
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' }
  ],
  defaultEffort: 'high',
  supportsFastMode: false
}

async function restingCatalog(input: {
  provider?: 'claude' | 'codex'
  options?: Record<string, string>
  savedModel?: string
  stale?: boolean
}) {
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({ claimStatus: 'released', ownerProcess: null })
  )
  record.provider = input.provider ?? 'claude'
  record.location.workspaceKind = 'folder'
  record.accountHome = {
    variable: record.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
    path: '/accounts/pinned'
  }
  record.options = input.options ?? {}
  let now = 1_000
  const store = new AgentModelCatalogStore({ now: () => now })
  const fingerprint = agentModelCatalogFingerprintForRecord(record)
  if (input.savedModel) {
    store.recordSuccess(fingerprint, record.provider, {
      models: [{ ...SAVED_MODEL, id: input.savedModel }],
      fastModeSupport: { supported: false, reason: 'model-not-supported' },
      fastModeTierByModel: new Map(),
      origin: 'probe'
    })
    if (input.stale) {
      now += AGENT_MODEL_CATALOG_FRESH_MS
      const failedProbe = async () => {
        throw new Error('temporarily unavailable')
      }
      await store.refresh(fingerprint, record.provider, failedProbe, failedProbe)
      expect(store.hasActiveFailure(fingerprint)).toBe(true)
    }
  }
  const agents = claudeAndCodexDeclared()
  const modelCatalog = createAgentModelCatalogService({
    store,
    getRecord: () => record,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/selected' })
  })
  const resting = {
    child: null,
    params: { provider: record.provider },
    journal: { contextUsage: () => null, threadGoal: () => null }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this at-rest read uses only these context members; no child or journal mutation runs.
  const context = {
    deps: { adapter: {}, agents, store: { getRecord: () => record }, modelCatalog },
    serialize: (_id: string, task: () => Promise<unknown>) => task(),
    openConversation: async () => resting,
    conversation: async () => resting
  } as unknown as StructuredAgentSessionMutationContext
  const result = await readStructuredAgentSessionOptions(context, record.sessionId)
  const state = applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG),
    CLAUDE_SESSION_OPTION_CATALOG,
    result
  )
  const write = (key: string, value: string) =>
    recordStructuredAgentSessionOptionIntent(
      { store: { getRecord: () => record }, agents },
      {
        sessionId: record.sessionId,
        persistOptions: async (options) => {
          record.options = options
        },
        publish: () => {}
      },
      { key, value }
    )
  return { record, result, state, write }
}

describe('Claude picker catalog at rest', () => {
  it.each([false, true])(
    'never adopts a saved default after an effort-only edit (stale: %s)',
    async (stale) => {
      const { record, result, state, write } = await restingCatalog({
        savedModel: SAVED_MODEL.id,
        stale
      })
      expect(await write('effort', 'low')).toMatchObject({
        ok: true,
        value: { options: { effort: 'low' } }
      })
      const persisted = applyNativeChatSessionOptionPicks({
        persisted: null,
        agent: 'claude',
        picks: structuredAgentSessionOptionPicks(state, record.options ?? {})
      })
      expect(resolveStructuredLaunchSeedOptions(persisted, 'claude')?.model).toBeUndefined()
      expect(result.current).toEqual({ model: '' })
      const model = structuredAgentSessionOptionSnapshot(state).find((row) => row.id === 'model')
      expect(model).toMatchObject({ valueSource: 'unknown' })
      expect(model?.kind).not.toHaveProperty('currentValue')
      expect(canSetStructuredAgentSessionOption(state, 'effort', 'low')).toBe(false)
      expect(await write('model', SAVED_MODEL.id)).toMatchObject({ ok: true })
      const selected = applyNativeChatSessionOptionPicks({
        persisted,
        agent: 'claude',
        picks: structuredAgentSessionOptionPicks(state, record.options ?? {})
      })
      expect(resolveStructuredLaunchSeedOptions(selected, 'claude')).toEqual({
        model: SAVED_MODEL.id,
        effort: 'low'
      })
    }
  )

  it.each([SAVED_MODEL.id, 'sonnet', undefined])(
    'allows effort choices with unavailable discovery and saved row %s',
    async (savedModel) => {
      const { record, result, state, write } = await restingCatalog({
        options: { model: 'sonnet', effort: 'high' },
        savedModel,
        stale: true
      })
      // Exercise the picker gate before the host write, not just the permissive backend.
      expect(canSetStructuredAgentSessionOption(state, 'effort', 'xhigh')).toBe(true)
      expect(await write('effort', 'xhigh')).toMatchObject({
        ok: true,
        value: { options: { model: 'sonnet', effort: 'xhigh' } }
      })
      expect(result.current).toEqual({ model: 'sonnet', effort: 'high' })
      expect(result.fastModeSupport).toBeUndefined()
      expect(result.models).toContainEqual(
        expect.objectContaining({ id: 'sonnet', isDefault: false })
      )
      for (const row of result.models) {
        expect(row.isDefault).toBe(false)
        expect(row).not.toHaveProperty('defaultEffort')
        expect(row).not.toHaveProperty('supportsFastMode')
      }
      if (savedModel) {
        expect(result.models).toContainEqual(
          expect.objectContaining({
            id: savedModel,
            label: SAVED_MODEL.label,
            description: SAVED_MODEL.description
          })
        )
      }
      const persisted = applyNativeChatSessionOptionPicks({
        persisted: null,
        agent: 'claude',
        picks: structuredAgentSessionOptionPicks(state, record.options ?? {})
      })
      expect(resolveStructuredLaunchSeedOptions(persisted, 'claude')).toEqual({
        model: 'sonnet',
        effort: 'xhigh'
      })
    }
  )

  it('keeps Codex resting catalog capabilities and default policy', async () => {
    const { result } = await restingCatalog({
      provider: 'codex',
      savedModel: SAVED_MODEL.id,
      stale: true
    })
    expect(result.models).toEqual([SAVED_MODEL])
    expect(result.current).toEqual({ model: SAVED_MODEL.id })
    expect(result.fastModeSupport).toEqual({ supported: false, reason: 'model-not-supported' })
  })
})
