import { describe, expect, it } from 'vitest'
import type { AgentComposerSignal } from './agent-composer-ready-watch'
import {
  evaluateTuiIdle,
  hasQuietMuseReadyPrompt,
  nameOnlyIdleNeedsCorroboration,
  type TuiIdleEvaluationInput,
  type TuiIdleEvidenceRecord
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

function input(overrides: Partial<TuiIdleEvaluationInput> = {}): TuiIdleEvaluationInput {
  return {
    record: record(),
    readTailBlockedReason: () => null,
    readPositiveBodyEvidence: () => false,
    readMuseReadyBodyEvidence: () => true,
    agent: 'muse',
    firstPartyStatus: null,
    quiescenceMs: QUIESCENCE_MS,
    ...overrides
  }
}

describe('hasQuietMuseReadyPrompt', () => {
  it('settles a Muse ready screen once the stream has gone quiet', () => {
    expect(hasQuietMuseReadyPrompt(record(), 'muse', () => true, QUIESCENCE_MS)).toBe(true)
  })

  it('refuses while the pane is still streaming', () => {
    expect(
      hasQuietMuseReadyPrompt(
        record({ lastOutputAt: Date.now() }),
        'muse',
        () => true,
        QUIESCENCE_MS
      )
    ).toBe(false)
  })

  it('refuses without an output clock, like the tier-3 lane', () => {
    expect(
      hasQuietMuseReadyPrompt(record({ lastOutputAt: null }), 'muse', () => true, QUIESCENCE_MS)
    ).toBe(false)
  })

  it('refuses without a ready screen', () => {
    expect(hasQuietMuseReadyPrompt(record(), 'muse', () => false, QUIESCENCE_MS)).toBe(false)
  })

  it('covers adopted panes that carry no launch metadata', () => {
    expect(hasQuietMuseReadyPrompt(record(), null, () => true, QUIESCENCE_MS)).toBe(true)
    expect(hasQuietMuseReadyPrompt(record(), undefined, () => true, QUIESCENCE_MS)).toBe(true)
  })

  it('refuses another agent quoting Muse in its scrollback', () => {
    expect(hasQuietMuseReadyPrompt(record(), 'codex', () => true, QUIESCENCE_MS)).toBe(false)
  })
})

describe('evaluateTuiIdle muse lane', () => {
  it('settles a quiet Muse pane with no title signal at all', () => {
    expect(evaluateTuiIdle(input())).toEqual({ kind: 'ready-strong' })
  })

  it('lets a fresh first-party working status veto the Muse body', () => {
    expect(
      evaluateTuiIdle(input({ firstPartyStatus: { state: 'working', updatedAt: Date.now() } }))
    ).toEqual({ kind: 'working' })
  })
})

describe('evaluateTuiIdle ranking', () => {
  const noMuse = { readMuseReadyBodyEvidence: () => false }

  it('ranks a blocking prompt in the tail above an explicit idle title', () => {
    const verdict = evaluateTuiIdle(
      input({
        ...noMuse,
        agent: 'claude',
        record: record({ lastAgentStatus: 'idle', lastOscTitle: '✳ Claude Code' }),
        readTailBlockedReason: () => 'agent-trust-workspace'
      })
    )
    expect(verdict).toEqual({ kind: 'blocked', reason: 'agent-trust-workspace' })
  })

  it("calls an agent's own idle title strong", () => {
    const verdict = evaluateTuiIdle(
      input({
        ...noMuse,
        agent: 'claude',
        record: record({ lastAgentStatus: 'idle', lastOscTitle: '✳ Claude Code' })
      })
    )
    expect(verdict).toEqual({ kind: 'ready-strong' })
  })

  it('calls a name-only title weak, even for an agent it is the only rest signal of', () => {
    const verdict = evaluateTuiIdle(
      input({ ...noMuse, agent: 'grok', record: record({ lastAgentStatus: 'idle' }) })
    )
    expect(verdict).toEqual({ kind: 'ready-weak' })
  })

  it("holds Claude's bare name to the quiet window, as an agent that announces rest itself", () => {
    const streaming = record({
      lastAgentStatus: 'idle',
      lastOscTitle: 'claude',
      lastOutputAt: Date.now()
    })
    expect(evaluateTuiIdle(input({ ...noMuse, agent: 'claude', record: streaming }))).toEqual({
      kind: 'pending',
      quietForeground: false
    })
    const quiet = record({ lastAgentStatus: 'idle', lastOscTitle: 'claude' })
    expect(evaluateTuiIdle(input({ ...noMuse, agent: 'claude', record: quiet }))).toEqual({
      kind: 'ready-weak'
    })
  })

  it('reads working, which suppresses the screen read, from a working title', () => {
    const verdict = evaluateTuiIdle(
      input({ ...noMuse, agent: 'claude', record: record({ lastAgentStatus: 'working' }) })
    )
    expect(verdict).toEqual({ kind: 'working' })
  })

  it('keeps a first-party blocked status pending, so the screen is still read', () => {
    const verdict = evaluateTuiIdle(
      input({
        ...noMuse,
        agent: null,
        record: record({ lastAgentStatus: 'idle', lastOscTitle: 'claude' }),
        firstPartyStatus: { state: 'blocked', updatedAt: Date.now() }
      })
    )
    expect(verdict).toEqual({ kind: 'pending', quietForeground: false })
  })

  it('leaves the quiet-foreground lane open only for an unidentified pane with no title status', () => {
    expect(evaluateTuiIdle(input({ ...noMuse, agent: null }))).toEqual({
      kind: 'pending',
      quietForeground: true
    })
    expect(evaluateTuiIdle(input({ ...noMuse, agent: 'claude' }))).toEqual({
      kind: 'pending',
      quietForeground: false
    })
  })
})

describe('evaluateTuiIdle composer rank (launch readiness)', () => {
  const goose = { readMuseReadyBodyEvidence: () => false, agent: 'goose' as const }
  const composer = (signal: AgentComposerSignal) => ({ readComposerSignal: () => signal })

  it('calls an armed composer weak once the stream is quiet', () => {
    expect(evaluateTuiIdle(input({ ...goose, ...composer('armed') }))).toEqual({
      kind: 'ready-weak'
    })
  })

  it('holds an armed composer while the agent is still painting, or without an output clock', () => {
    for (const lastOutputAt of [Date.now(), null]) {
      expect(
        evaluateTuiIdle(input({ ...goose, ...composer('armed'), record: record({ lastOutputAt }) }))
          .kind
      ).toBe('pending')
    }
  })

  it("calls the agent's own composer marker weak without waiting for quiet", () => {
    expect(
      evaluateTuiIdle(
        input({ ...goose, ...composer('ready'), record: record({ lastOutputAt: Date.now() }) })
      )
    ).toEqual({ kind: 'ready-weak' })
  })

  it('is absent from a plain tui-idle wait, which also waits out turns', () => {
    expect(evaluateTuiIdle(input({ ...goose })).kind).toBe('pending')
    expect(evaluateTuiIdle(input({ ...goose, ...composer('unowned') })).kind).toBe('pending')
  })

  it("replaces a name-only idle title while the declared agent's command owns the PTY", () => {
    // OpenCode names itself in its title before its composer mounts.
    const opencode = {
      readMuseReadyBodyEvidence: () => false,
      agent: 'opencode' as const,
      record: record({ lastAgentStatus: 'idle' })
    }
    expect(evaluateTuiIdle(input({ ...opencode, ...composer('pending') })).kind).toBe('pending')
    expect(evaluateTuiIdle(input({ ...opencode, ...composer('ready') }))).toEqual({
      kind: 'ready-weak'
    })
    // Unowned (no command-start mark) and a plain wait keep the title, exactly as before.
    expect(evaluateTuiIdle(input({ ...opencode, ...composer('unowned') }))).toEqual({
      kind: 'ready-weak'
    })
    expect(evaluateTuiIdle(input({ ...opencode }))).toEqual({ kind: 'ready-weak' })
  })

  it('loses to a working or permission title, a blocking prompt and a first-party working status', () => {
    for (const lastAgentStatus of ['working', 'permission'] as const) {
      expect(
        evaluateTuiIdle(
          input({ ...goose, ...composer('ready'), record: record({ lastAgentStatus }) })
        ).kind
      ).not.toBe('ready-weak')
    }
    expect(
      evaluateTuiIdle(
        input({
          ...goose,
          ...composer('ready'),
          readTailBlockedReason: () => 'agent-trust-workspace'
        })
      ).kind
    ).toBe('blocked')
    expect(
      evaluateTuiIdle(
        input({
          ...goose,
          ...composer('ready'),
          firstPartyStatus: { state: 'working', updatedAt: Date.now() }
        })
      ).kind
    ).toBe('working')
  })
})

describe('nameOnlyIdleNeedsCorroboration', () => {
  it('holds agents that announce rest with an explicit title, native or synthesized', () => {
    expect(nameOnlyIdleNeedsCorroboration('claude')).toBe(true)
    expect(nameOnlyIdleNeedsCorroboration('codex')).toBe(true)
  })

  it('exempts agents whose name is their only rest signal', () => {
    expect(nameOnlyIdleNeedsCorroboration('grok')).toBe(false)
  })

  it("names an adopted pane's agent from a shell auto-title", () => {
    expect(nameOnlyIdleNeedsCorroboration(null, 'claude')).toBe(true)
    expect(nameOnlyIdleNeedsCorroboration(null, 'claude ~/p/repo')).toBe(true)
  })
})
