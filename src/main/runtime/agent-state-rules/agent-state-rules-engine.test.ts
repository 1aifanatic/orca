import { describe, expect, it } from 'vitest'
import { evaluateTuiIdle, type TuiIdleEvaluationInput } from '../tui-idle-evidence'
import { isKnownReadyPromptBody, isQuietReadyScreenBody } from '../terminal-wait-detection'
import {
  compileAgentRules,
  evaluateAgentStateRules,
  evaluateCompiledRules,
  type AgentStateVerdict
} from './agent-state-rules-engine'
import { parseAgentStateRuleFiles } from './agent-state-rules-catalog'

const QUIESCENCE_MS = 3000

type RuleFileOverrides = { rules?: unknown[]; textAnchors?: unknown[] } & Record<string, unknown>

function ruleFile(overrides: RuleFileOverrides = {}): Record<string, unknown> {
  return { id: 'cline', engineVersion: 1, textAnchors: [], rules: [], ...overrides }
}

function idleRule(id: string, priority: number, rows: unknown[]): Record<string, unknown> {
  return {
    id,
    priority,
    region: 'screen',
    state: 'idle',
    strength: 'strong',
    requiresQuiet: true,
    match: { rows }
  }
}

const HOLD = { id: 'hold', priority: 100, region: 'screen', state: 'hold' }

function evaluate(rules: unknown[], screen: readonly string[] | null): string | null {
  const [file] = parseAgentStateRuleFiles([ruleFile({ rules })])
  return (
    evaluateCompiledRules(compileAgentRules(file), { readScreenLines: () => screen })?.ruleId ??
    null
  )
}

describe('agent state rules schema', () => {
  it.each([
    ['an unknown field', ruleFile({ fallback: 'quiet' })],
    ['an unknown agent', ruleFile({ id: 'not-an-agent' })],
    ['another engine version', ruleFile({ engineVersion: 2 })],
    ['a misspelled rule field', ruleFile({ rules: [{ ...HOLD, requireQuiet: true }] })],
    ['a backreference', ruleFile({ rules: [idleRule('a', 1, [{ regex: '(a)\\1' }])] })],
    ['a lookbehind', ruleFile({ rules: [idleRule('a', 1, [{ regex: '(?<=a)b' }])] })],
    ['nested quantifiers', ruleFile({ rules: [idleRule('a', 1, [{ regex: '(a+)+$' }])] })],
    ['a pattern that does not compile', ruleFile({ rules: [idleRule('a', 1, [{ regex: '(' }])] })],
    [
      'an optional last row',
      ruleFile({ rules: [idleRule('a', 1, [{ optional: { contains: '>' } }])] })
    ],
    [
      'a codex-only blocked reason',
      ruleFile({
        textAnchors: [
          { id: 'b', state: 'blocked', reason: 'codex-update-prompt', lastOf: 'update' }
        ]
      })
    ],
    [
      'an unregistered named anchor',
      ruleFile({ textAnchors: [{ id: 'p', state: 'idle', find: { predicate: 'nope' } }] })
    ]
  ])('rejects %s', (_label, file) => {
    expect(() => parseAgentStateRuleFiles([file])).toThrow()
  })

  it('rejects two files for one agent', () => {
    expect(() => parseAgentStateRuleFiles([ruleFile(), ruleFile()])).toThrow(/two files/)
  })

  it('accepts a quantified group whose body does not repeat', () => {
    expect(() =>
      parseAgentStateRuleFiles([
        ruleFile({ rules: [idleRule('a', 1, [{ regex: '(?: or [a-z])*' }])] })
      ])
    ).not.toThrow()
  })
})

describe('priority evaluation', () => {
  const ready = idleRule('ready', 500, [{ regex: '^>$' }])

  it('answers with the highest-priority match whatever the file order', () => {
    expect(evaluate([HOLD, ready], ['>'])).toBe('ready')
    expect(evaluate([HOLD, ready], ['busy'])).toBe('hold')
  })

  it('breaks priority ties by file order', () => {
    const tiedHold = { ...HOLD, priority: 500 }
    expect(evaluate([tiedHold, ready], ['>'])).toBe('hold')
    expect(evaluate([ready, tiedHold], ['>'])).toBe('ready')
  })

  it('gives no answer without a readable screen, so the caller decides', () => {
    expect(evaluate([ready, HOLD], null)).toBeNull()
  })

  it('gives no answer when nothing matches and there is no hold', () => {
    expect(evaluate([ready], ['busy'])).toBeNull()
  })
})

describe('screen rows', () => {
  const block = (match: Record<string, unknown>) => [
    { id: 'm', priority: 1, region: 'screen', state: 'hold', match }
  ]

  it('reads rows above the screen as empty', () => {
    const rows = [{ none: [{ contains: '⠋' }] }, { regex: '^>$' }]
    expect(evaluate(block({ rows }), ['>'])).toBe('m')
    expect(evaluate(block({ rows: [{ regex: '^─+$' }, { regex: '^>$' }] }), ['>'])).toBeNull()
  })

  it('skips an optional row that does not match', () => {
    const rows = [{ regex: '^top$' }, { optional: { contains: 'hint' } }, { regex: '^>$' }]
    expect(evaluate(block({ rows }), ['top', 'hint', '>'])).toBe('m')
    expect(evaluate(block({ rows }), ['top', '>'])).toBe('m')
    expect(evaluate(block({ rows }), ['other', '>'])).toBeNull()
  })

  it('ends the block at the lowest match within endsWithinBottom', () => {
    const rows = [{ regex: '^─+$' }, { regex: '^mode$' }]
    expect(evaluate(block({ rows, endsWithinBottom: 2 }), ['───', 'mode', 'cwd'])).toBe('m')
    expect(evaluate(block({ rows, endsWithinBottom: 1 }), ['───', 'mode', 'cwd'])).toBeNull()
  })

  it('vetoes a block when a row above it matches noneAbove', () => {
    const match = { rows: [{ regex: '^>$' }], noneAbove: { contains: '⠋' } }
    expect(evaluate(block(match), ['⠋ thinking', '>'])).toBeNull()
    expect(evaluate(block(match), ['done', '>'])).toBe('m')
  })

  it('combines all, any and none on one row', () => {
    const rows = [{ all: [{ regex: '\\)$' }], any: [{ contains: 'yes' }, { contains: 'no' }] }]
    expect(evaluate(block({ rows }), ['yes (y)'])).toBe('m')
    expect(evaluate(block({ rows }), ['maybe (m)'])).toBeNull()
  })
})

describe('strength and quiet through the tui-idle ranking', () => {
  const now = Date.now()

  function verdictFor(ruled: AgentStateVerdict, lastOutputAt: number | null): string {
    const input: TuiIdleEvaluationInput = {
      record: { lastAgentStatus: null, lastOutputAt, lastOscTitle: null },
      readTailBlockedReason: () => null,
      readPositiveBodyEvidence: () => false,
      readQuietReadyBodyEvidence: () => false,
      readAgentRuleVerdict: () => ruled,
      agent: 'cline',
      firstPartyStatus: null,
      quiescenceMs: QUIESCENCE_MS
    }
    const verdict = evaluateTuiIdle(input)
    return verdict.kind === 'pending' ? `pending:${verdict.quietForeground}` : verdict.kind
  }

  const weak = (requiresQuiet: boolean): AgentStateVerdict => ({
    ruleId: 'w',
    state: 'idle',
    strength: 'weak',
    requiresQuiet
  })

  it('settles weak idle only on the weak lane, and only once quiet when it asks to', () => {
    expect(verdictFor(weak(false), now)).toBe('ready-weak')
    expect(verdictFor(weak(true), now)).toBe('pending:closed')
    expect(verdictFor(weak(true), now - QUIESCENCE_MS)).toBe('ready-weak')
    expect(verdictFor(weak(true), null)).toBe('pending:closed')
  })

  it('holds every weak lane on a hold', () => {
    expect(verdictFor({ ruleId: 'h', state: 'hold' }, now - QUIESCENCE_MS)).toBe('pending:closed')
  })
})

describe('a bundled strong, quiet idle rule', () => {
  // Antigravity's idle composer (agent-state-rules/antigravity.json).
  const readyScreen = ['─'.repeat(20), '>', '─'.repeat(20), '? for shortcuts']

  it('is believed at once on a pane with no output clock', () => {
    expect(isKnownReadyPromptBody('', 'antigravity', () => readyScreen, false)).toBe(true)
  })

  it('waits for quiet on a clocked pane', () => {
    expect(isKnownReadyPromptBody('', 'antigravity', () => readyScreen, true)).toBe(false)
    expect(isQuietReadyScreenBody('', 'antigravity', () => readyScreen)).toBe(true)
  })

  it('holds when the screen shows something else', () => {
    const picker = [...readyScreen.slice(0, 3), 'esc to cancel']
    expect(evaluateAgentStateRules('antigravity', { readScreenLines: () => picker })?.state).toBe(
      'hold'
    )
  })
})
