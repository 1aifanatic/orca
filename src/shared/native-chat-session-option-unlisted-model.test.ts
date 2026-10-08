import { describe, expect, it } from 'vitest'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from './agent-session-option-catalog-claude-codex'
import { buildNativeChatSessionOptionSnapshot } from './native-chat-session-option-snapshot'
import { createNativeChatSessionOptionRecord } from './native-chat-session-option-state'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot,
  structuredAgentSessionOptionView
} from './structured-agent-session-options'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const REMEMBERED_MODELS = [{ id: 'sonnet', label: 'Saved Sonnet', isDefault: false, efforts: [] }]

describe('unlisted Claude picker selections', () => {
  it.each(['opus', 'haiku', 'new-account-model'])(
    'uses unknown capabilities for %s at the shared boundary, including an empty list',
    (model) => {
      const record = createNativeChatSessionOptionRecord('claude')
      record.model = { value: model, source: 'dispatched' }
      record.valuesByModel[model] = { effort: { value: 'high', source: 'dispatched' } }
      for (const models of [[], [{ id: 'sonnet', label: 'Saved Sonnet', options: [] }]]) {
        const snapshot = buildNativeChatSessionOptionSnapshot({
          catalog: CLAUDE_SESSION_OPTION_CATALOG,
          models,
          record,
          mode: 'live',
          modelLabel: 'Model',
          liveTransport: 'agent-session'
        })
        const effort = snapshot.find((row) => row.id === 'effort')
        expect(effort?.kind).toMatchObject({ currentValue: 'high' })
        expect(
          effort?.kind.type === 'select' ? effort.kind.choices.map((row) => row.value) : []
        ).toEqual(EFFORTS)
        expect(snapshot.find((row) => row.id === 'fastMode')).toBeUndefined()
      }
    }
  )

  it.each(['seed', 'host', 'resting'] as const)(
    'keeps seeded, held and record-selected models usable with a %s catalog',
    (source) => {
      const seed = CLAUDE_SESSION_OPTION_CATALOG
      let state = createStructuredAgentSessionOptionState('claude', seed)
      if (source === 'host') {
        state = applyStructuredAgentSessionModelCatalog(
          state,
          seed,
          {
            origin: 'probe',
            fetchedAt: 1_000,
            models: REMEMBERED_MODELS
          },
          { namesDefault: false }
        )
      } else if (source === 'resting') {
        state = applyStructuredAgentSessionOptions(state, seed, {
          models: REMEMBERED_MODELS,
          current: { model: '' }
        })
      }
      for (const model of ['opus', 'haiku', 'new-account-model']) {
        for (const selection of ['seeded', 'held', 'record'] as const) {
          const picks = { model, effort: 'high' }
          const selected =
            selection === 'record'
              ? {
                  ...state,
                  record: {
                    agent: 'claude' as const,
                    model: { value: model, source: 'reported' as const },
                    valuesByModel: {
                      [model]: { effort: { value: 'high', source: 'reported' as const } }
                    }
                  }
                }
              : structuredAgentSessionOptionView(
                  state,
                  selection === 'seeded' ? picks : undefined,
                  selection === 'held' ? picks : {}
                )
          // Static rows already in the seed keep their own policy; this checks missing rows.
          if (source === 'seed' && model !== 'new-account-model') {
            continue
          }
          const effort = structuredAgentSessionOptionSnapshot(selected).find(
            (row) => row.id === 'effort'
          )
          expect(effort?.kind).toMatchObject({ currentValue: 'high' })
          expect(
            effort?.kind.type === 'select' ? effort.kind.choices.map((row) => row.value) : []
          ).toEqual(EFFORTS)
          expect(canSetStructuredAgentSessionOption(selected, 'effort', 'xhigh')).toBe(true)
        }
      }
    }
  )

  it.each([
    { efforts: [] },
    {
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' }
      ]
    }
  ])('preserves a live child row with effort choices $efforts', ({ efforts }) => {
    const seed = CLAUDE_SESSION_OPTION_CATALOG
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('claude', seed),
      seed,
      {
        models: [{ id: 'opus', label: 'Live Opus', isDefault: false, efforts }],
        current: { model: 'opus', effort: 'high' }
      }
    )
    expect(canSetStructuredAgentSessionOption(state, 'effort', 'xhigh')).toBe(false)
    const effort = structuredAgentSessionOptionSnapshot(state).find((row) => row.id === 'effort')
    expect(
      effort?.kind.type === 'select' ? effort.kind.choices.map((row) => row.value) : []
    ).toEqual(efforts.map((row) => row.value))
  })

  it('keeps an absent Codex selection on its existing provisional policy', () => {
    const state = structuredAgentSessionOptionView(
      createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG),
      { model: 'gpt-unlisted', effort: 'high' },
      {}
    )
    expect(structuredAgentSessionOptionSnapshot(state).map((row) => row.id)).toEqual(['model'])
    expect(canSetStructuredAgentSessionOption(state, 'effort', 'xhigh')).toBe(false)
  })
})
