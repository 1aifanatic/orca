import { describe, expect, it } from 'vitest'
import type { AgentSessionModelCatalogResult } from './agent-session-wire'
import { structuredAgentSessionSeedCatalog } from './structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-options'

// Every agent a runtime registers today; the main-side contract test walks the registrations.
const AGENTS = ['claude', 'codex', 'grok', 'opencode', 'pi'] as const

const HOST_CATALOG: AgentSessionModelCatalogResult = {
  origin: 'probe',
  models: [
    {
      id: 'model-listed',
      label: 'Model Listed',
      isDefault: true,
      defaultEffort: 'high',
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' }
      ]
    }
  ],
  fetchedAt: 1_000
}

function firstFrame(agent: string, host: AgentSessionModelCatalogResult | null) {
  const seed = structuredAgentSessionSeedCatalog(agent)
  const cold = createStructuredAgentSessionOptionState(agent, seed)
  const state = host
    ? applyStructuredAgentSessionModelCatalog(cold, seed, host, { namesDefault: false })
    : cold
  return { seed, state, snapshot: structuredAgentSessionOptionSnapshot(state) }
}

describe('the first frame of every agent’s picker', () => {
  it.each(AGENTS)(
    '%s: a cold or failed listing shows a model pill nobody can pick from',
    (agent) => {
      for (const host of [null, { origin: 'unknown' as const }]) {
        const { seed, state, snapshot } = firstFrame(agent, host)
        const model = snapshot.find((descriptor) => descriptor.id === 'model')
        expect(model).toBeDefined()
        if (seed.models.length === 0) {
          // The provider-default placeholder: no choice, so showing it can never seed a launch.
          expect(model).toMatchObject({
            valueSource: 'unknown',
            settable: false,
            kind: { choices: [] }
          })
          expect(canSetStructuredAgentSessionOption(state, 'model', 'anything')).toBe(false)
        } else {
          // A built-in list is presentation only: no value is tracked from it.
          expect(state.record.model).toBeUndefined()
        }
      }
    }
  )

  it.each(AGENTS)(
    '%s: a warm host catalog lists its models before the session reports',
    (agent) => {
      const { state, snapshot } = firstFrame(agent, HOST_CATALOG)
      expect(state.catalogSource).toBe('host')
      const model = snapshot.find((descriptor) => descriptor.id === 'model')
      expect(
        model?.kind.type === 'select' && model.kind.choices.map((choice) => choice.value)
      ).toEqual(['model-listed'])
      // Listed, not picked: nothing reads as a value the chat confirmed or will launch with.
      expect(state.record.model).toBeUndefined()
    }
  )

  it.each(AGENTS)('%s: the live session corrects the host list', (agent) => {
    const { seed, state } = firstFrame(agent, HOST_CATALOG)
    const live = applyStructuredAgentSessionOptions(state, seed, {
      models: [{ id: 'model-live', label: 'Model Live', isDefault: false, efforts: [] }],
      current: { model: 'model-live', confirmed: ['model'] }
    })
    expect(live.catalogSource).toBe('live')
    expect(live.catalog?.models.map((model) => model.id)).toEqual(['model-live'])
    // A later host answer never downgrades what the session reported.
    expect(
      applyStructuredAgentSessionModelCatalog(live, seed, HOST_CATALOG, { namesDefault: false })
    ).toBe(live)
  })
})
