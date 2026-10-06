import { describe, expect, it } from 'vitest'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-options'

const modes = [
  { value: 'review', label: 'Review' },
  { value: 'plan', label: 'Plan' }
]
const seed = { models: [], modelApply: {} }

describe('provider-reported primary modes', () => {
  it('renders only offered choices and preserves the mode the native session reported', () => {
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('opencode2'),
      seed,
      {
        models: [
          {
            id: 'provider/model',
            label: 'Model',
            isDefault: true,
            efforts: [],
            contextWindowTokens: 100_000
          }
        ],
        modes,
        current: { model: 'provider/model', mode: 'review', confirmed: ['model', 'mode'] }
      }
    )
    expect(state.catalog?.models[0].contextWindowTokens).toBe(100_000)
    expect(
      structuredAgentSessionOptionSnapshot(state).find((row) => row.id === 'mode')
    ).toMatchObject({
      settable: true,
      valueSource: 'reported',
      transport: 'agent-session',
      kind: { type: 'select', choices: modes, currentValue: 'review' }
    })
  })

  it('offers modes for an unconfigured model without inventing a current primary agent', () => {
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('opencode'),
      seed,
      { models: [], modes, current: { model: 'default', confirmed: [] } }
    )
    const row = structuredAgentSessionOptionSnapshot(state).find((row) => row.id === 'mode')
    expect(row).toMatchObject({ valueSource: 'unknown', kind: { type: 'select', choices: modes } })
    expect(row?.kind).not.toHaveProperty('currentValue')
  })
})
