import { describe, expect, it } from 'vitest'
import {
  planStartupWithPromptCandidate,
  TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES
} from './startup-line-prompt-carry'
import type { TuiAgent } from './tui-agent'
import {
  AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from './protocol-version'

function offer(agent: TuiAgent, prompt: string, extra: { cmdOverride?: string } = {}) {
  return planStartupWithPromptCandidate(
    {
      agent,
      cmdOverrides: extra.cmdOverride ? { [agent]: extra.cmdOverride } : {},
      platform: 'darwin'
    },
    prompt
  )
}

/** A prompt that brings the quoted `claude '<prompt>'` line to exactly `bytes`. */
function promptForClaudeLineOf(bytes: number): string {
  const base = offer('claude', '').plan?.launchCommand ?? ''
  // `<base> '<prompt>'`: one space and two quotes around the text.
  return 'x'.repeat(bytes - base.length - 3)
}

describe('whether a launch prompt rides the typed startup line', () => {
  it('carries a short single-line prompt on the launch command', () => {
    const { plan, promptCarried } = offer('claude', 'explain this repo')
    expect(promptCarried).toBe(true)
    expect(plan?.launchCommand).toContain('explain this repo')
  })

  it('carries a line of exactly the budget and refuses one byte past it', () => {
    const atBudget = offer('claude', promptForClaudeLineOf(TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES))
    expect(new TextEncoder().encode(atBudget.plan?.launchCommand ?? '').byteLength).toBe(
      TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES
    )
    expect(atBudget.promptCarried).toBe(true)

    const pastBudget = offer(
      'claude',
      promptForClaudeLineOf(TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES + 1)
    )
    expect(pastBudget.promptCarried).toBe(false)
  })

  it('measures the quoted line, so quote-heavy text under the budget raw can exceed it typed', () => {
    // 200 quotes are 200 raw bytes but 600 once portable quoting expands each to `"'"`.
    const quotes = "'".repeat(200)
    expect(quotes.length).toBeLessThan(TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES)
    const { plan, promptCarried } = offer('claude', quotes)
    expect(promptCarried).toBe(false)
    expect(plan?.launchCommand).not.toContain(`"'"`)
  })

  it.each([
    ['LF', 'first line\nsecond line'],
    ['CRLF', 'first line\r\nsecond line'],
    ['CR', 'first line\rsecond line']
  ])('never types a %s-bearing prompt, which a shell would read as Enter', (_label, prompt) => {
    const { plan, promptCarried } = offer('codex', prompt)
    expect(promptCarried).toBe(false)
    // The clean launch: the prompt is left for the paste after start.
    expect(plan?.launchCommand).not.toContain('first line')
    expect(plan?.followupPrompt).toBeNull()
  })

  it('counts the launcher toward the line, so a long configured one leaves no room for the prompt', () => {
    const launcher = `claude ${'--add-dir /very/long/path '.repeat(30)}`.trim()
    expect(launcher.length).toBeGreaterThan(TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES)
    const { plan, promptCarried } = offer('claude', 'hi', { cmdOverride: launcher })
    expect(promptCarried).toBe(false)
    expect(plan?.launchCommand).toBe(launcher)
  })

  it('carries a Hermes prompt through its env transport, whose typed line never holds the text', () => {
    const multiLine = 'line one\nline two'
    const { plan, promptCarried } = offer('hermes', multiLine)
    expect(promptCarried).toBe(true)
    expect(plan?.launchCommand).not.toContain('line one')
    expect(Object.values(plan?.env ?? {})).toContain(multiLine)
  })

  it('launches Hermes clean instead of refusing when its env budget cannot hold the prompt', () => {
    const { plan, promptCarried } = offer('hermes', 'x'.repeat(30_000))
    expect(promptCarried).toBe(false)
    expect(plan).not.toBeNull()
    expect(Object.values(plan?.env ?? {}).join('')).not.toContain('xxxx')
  })

  it('never carries a stdin-after-start agent’s prompt, whose CLI takes none', () => {
    const { plan, promptCarried } = offer('aider', 'fix it')
    expect(promptCarried).toBe(false)
    expect(plan?.followupPrompt).toBeNull()
  })

  it('reports nothing carried for an empty prompt', () => {
    expect(offer('claude', '   ').promptCarried).toBe(false)
  })
})

describe('the capability clients gate a prompted launch on', () => {
  it('is advertised by every host that applies the typed-line rule', () => {
    // An older host folds any prompt into the typed line, so its absence is the gate.
    expect(RUNTIME_CAPABILITIES).toContain(AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY)
  })
})
