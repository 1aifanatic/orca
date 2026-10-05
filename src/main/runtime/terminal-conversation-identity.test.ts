import { describe, expect, it } from 'vitest'
import {
  resolveTerminalConversationIdentity,
  type LegacyIdentityCandidate
} from './terminal-conversation-identity'

const S = { key: 'session_id' as const, id: 'S', transcriptPath: 'C:\\Users\\me\\rollout-S.jsonl' }
const facet = { agentType: 'codex', providerSession: S, model: 'P', capturedAt: 10 }
const legacy: LegacyIdentityCandidate = {
  providerSession: S,
  sessionAgent: 'codex',
  model: 'P',
  capturedAt: 20,
  source: 'legacy-row'
}
const launchOwner = { ownerIsLaunch: true }

describe('resolveTerminalConversationIdentity', () => {
  it('publishes a compatible facet, with its source from the row', () => {
    for (const rowIsRemnant of [false, true]) {
      expect(
        resolveTerminalConversationIdentity({
          stored: { facet, rowIsRemnant },
          legacy,
          ownerAgent: 'codex',
          ownerOptions: launchOwner
        })
      ).toEqual({ ...facet, source: rowIsRemnant ? 'retained' : 'live' })
    }
  })

  it('names a compatible launch owner as the agent', () => {
    expect(
      resolveTerminalConversationIdentity({
        stored: { facet: { ...facet, agentType: 'pi' }, rowIsRemnant: false },
        legacy: null,
        ownerAgent: 'omp',
        ownerOptions: launchOwner
      })
    ).toMatchObject({ agentType: 'omp', providerSession: S })
  })

  it('publishes null for an explicit or incompatible facet, never the legacy row', () => {
    expect(
      resolveTerminalConversationIdentity({
        stored: { facet: null, rowIsRemnant: false },
        legacy,
        ownerAgent: 'codex',
        ownerOptions: launchOwner
      })
    ).toBeNull()
    expect(
      resolveTerminalConversationIdentity({
        stored: { facet, rowIsRemnant: false },
        legacy,
        ownerAgent: 'claude',
        ownerOptions: launchOwner
      })
    ).toBeNull()
  })

  it('falls back to the legacy row only when the store holds no facet', () => {
    expect(
      resolveTerminalConversationIdentity({
        stored: undefined,
        legacy,
        ownerAgent: null,
        ownerOptions: { ownerIsLaunch: false }
      })
    ).toEqual({
      agentType: 'codex',
      providerSession: S,
      model: 'P',
      capturedAt: 20,
      source: 'legacy-row'
    })
  })

  it('publishes nothing (absent, not null) when there is no usable evidence', () => {
    for (const args of [
      { legacy: null, ownerAgent: 'codex' },
      { legacy: { ...legacy, sessionAgent: null }, ownerAgent: null },
      { legacy, ownerAgent: 'claude' }
    ]) {
      expect(
        resolveTerminalConversationIdentity({
          stored: undefined,
          ownerOptions: launchOwner,
          ...args
        })
      ).toBeUndefined()
    }
  })
})
