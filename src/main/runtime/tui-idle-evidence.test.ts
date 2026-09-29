import { describe, expect, it } from 'vitest'
import {
  hasQuietReadyScreen,
  isTuiIdleSatisfied,
  type TuiIdleEvidenceRecord,
  type TuiIdleSatisfactionInput
} from './tui-idle-evidence'

const QUIESCENCE_MS = 3000

function record(overrides: Partial<TuiIdleEvidenceRecord> = {}): TuiIdleEvidenceRecord {
  return {
    lastAgentStatus: null,
    lastOutputAt: Date.now() - QUIESCENCE_MS * 2,
    lastOscTitle: 'tmp',
    ...overrides
  }
}

function input(overrides: Partial<TuiIdleSatisfactionInput> = {}): TuiIdleSatisfactionInput {
  return {
    record: record(),
    readPositiveBodyEvidence: () => false,
    readQuietReadyBodyEvidence: () => true,
    agent: 'muse',
    firstPartyStatus: null,
    quiescenceMs: QUIESCENCE_MS,
    ...overrides
  }
}

describe('hasQuietReadyScreen', () => {
  it('settles a Muse ready screen once the stream has gone quiet', () => {
    expect(hasQuietReadyScreen(record(), 'muse', () => true, QUIESCENCE_MS)).toBe(true)
  })

  it('refuses while the pane is still streaming', () => {
    expect(
      hasQuietReadyScreen(record({ lastOutputAt: Date.now() }), 'muse', () => true, QUIESCENCE_MS)
    ).toBe(false)
  })

  it('refuses without an output clock, like the tier-3 lane', () => {
    expect(
      hasQuietReadyScreen(record({ lastOutputAt: null }), 'muse', () => true, QUIESCENCE_MS)
    ).toBe(false)
  })

  it('refuses without a ready screen', () => {
    expect(hasQuietReadyScreen(record(), 'muse', () => false, QUIESCENCE_MS)).toBe(false)
  })

  it('covers adopted panes that carry no launch metadata', () => {
    expect(hasQuietReadyScreen(record(), null, () => true, QUIESCENCE_MS)).toBe(true)
    expect(hasQuietReadyScreen(record(), undefined, () => true, QUIESCENCE_MS)).toBe(true)
  })

  it('covers Codex, whose title carries no rest signal once idle', () => {
    expect(hasQuietReadyScreen(record(), 'codex', () => true, QUIESCENCE_MS)).toBe(true)
  })

  it('refuses another agent quoting Muse or Codex in its scrollback', () => {
    expect(hasQuietReadyScreen(record(), 'claude', () => true, QUIESCENCE_MS)).toBe(false)
  })
})

describe('isTuiIdleSatisfied muse lane', () => {
  it('settles a quiet Muse pane with no title signal at all', () => {
    expect(isTuiIdleSatisfied(input())).toBe(true)
  })

  it('lets a fresh first-party working status veto the Muse body', () => {
    expect(
      isTuiIdleSatisfied(input({ firstPartyStatus: { state: 'working', updatedAt: Date.now() } }))
    ).toBe(false)
  })
})
