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
          stored: { facet, rowAgent: 'codex', rowIsRemnant },
          legacy,
          ownerAgent: 'codex',
          ownerOptions: launchOwner
        })
      ).toEqual({ ...facet, source: rowIsRemnant ? 'retained' : 'live' })
    }
  })

  it('names a compatible launch owner as the agent', () => {
    for (const rowAgent of ['pi', 'omp', null]) {
      expect(
        resolveTerminalConversationIdentity({
          stored: { facet: { ...facet, agentType: 'pi' }, rowAgent, rowIsRemnant: false },
          legacy: null,
          ownerAgent: 'omp',
          ownerOptions: launchOwner
        })
      ).toMatchObject({ agentType: 'omp', providerSession: S })
    }
  })

  it("publishes a hand-started agent's facet in a pane launched as another agent", () => {
    expect(
      resolveTerminalConversationIdentity({
        stored: { facet, rowAgent: 'codex', rowIsRemnant: false },
        legacy,
        ownerAgent: 'claude',
        ownerOptions: launchOwner
      })
    ).toEqual({ ...facet, source: 'live' })
  })

  it("withholds (absent, never null) a facet of another agent than the row's, whatever the owner", () => {
    for (const ownerAgent of [null, 'claude']) {
      expect(
        resolveTerminalConversationIdentity({
          stored: {
            facet: { ...facet, agentType: 'claude' },
            rowAgent: 'amp',
            rowIsRemnant: false
          },
          legacy,
          ownerAgent,
          ownerOptions: { ownerIsLaunch: ownerAgent !== null }
        })
      ).toBeUndefined()
    }
  })

  it('checks a facet against the owner when the row names no agent, never falling back to legacy', () => {
    expect(
      resolveTerminalConversationIdentity({
        stored: { facet, rowAgent: null, rowIsRemnant: false },
        legacy,
        ownerAgent: 'claude',
        ownerOptions: launchOwner
      })
    ).toBeUndefined()
    expect(
      resolveTerminalConversationIdentity({
        stored: { facet, rowAgent: null, rowIsRemnant: false },
        legacy,
        ownerAgent: null,
        ownerOptions: { ownerIsLaunch: false }
      })
    ).toEqual({ ...facet, source: 'live' })
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

  it('publishes nothing when there is no usable evidence', () => {
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
