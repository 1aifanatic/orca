import { describe, expect, it } from 'vitest'
import { parseAgentStateRuleFiles } from './agent-state-rules-catalog'
import { compileTextAnchors, findPromptAnchorIndexes } from './agent-state-text-anchors'
import { TERMINAL_WAIT_BLOCKED_SENTINEL_RE } from './blocked-text-layer'
import { detectTerminalWaitBlockedReason } from '../terminal-wait-detection'

function anchorsOf(textAnchors: unknown[]) {
  return compileTextAnchors(
    parseAgentStateRuleFiles([{ id: 'cursor', engineVersion: 1, textAnchors, rules: [] }])
  )
}

describe('blocked anchors', () => {
  const [menu] = anchorsOf([
    {
      id: 'menu',
      state: 'blocked',
      reason: 'agent-approval-prompt',
      withinLastLines: 4,
      lastOf: 'run it?',
      lines: { atLeast: 2, includingLast: true, test: { regex: '\\([a-z]\\)$' } }
    }
  ]).blocked

  it('reports where the anchor starts once enough choices own the bottom', () => {
    const text = 'chat\nrun it?\nyes (y)\nno (n)\n'
    expect(menu(text)).toEqual({ reason: 'agent-approval-prompt', index: text.indexOf('run it?') })
  })

  it('refuses a menu with too few choices, or one no longer at the bottom', () => {
    expect(menu('run it?\nyes (y)\n')).toBeNull()
    expect(menu('run it?\nyes (y)\nno (n)\nlater output')).toBeNull()
  })

  it('reads only the last lines', () => {
    expect(menu('run it?\na\nb\nyes (y)\nno (n)')).toBeNull()
  })
})

describe('prompt anchors', () => {
  const { prompts } = anchorsOf([
    {
      id: 'prompt',
      state: 'idle',
      find: { lastOf: 'banner', followedBy: '→' },
      workingIfAfter: { contains: '⠋' }
    }
  ])
  const [prompt] = prompts

  it('needs the follower after the last banner', () => {
    expect(prompt('banner\n→')).toEqual({ index: 0, working: false })
    expect(prompt('→ banner')).toBeNull()
  })

  it('stays a live prompt while busy', () => {
    expect(prompt('banner\n⠋ working\n→')).toEqual({ index: 0, working: true })
  })

  it('reads a bundled busy prompt as live but not ready', () => {
    expect(findPromptAnchorIndexes('cursor agent\n⠋ generating\n→')).toEqual({
      live: 0,
      ready: null
    })
    expect(findPromptAnchorIndexes('cursor agent\n→')).toEqual({ live: 0, ready: 0 })
  })
})

describe('the bundled Cursor approval menu', () => {
  it('blocks once two choices own the bottom of the tail', () => {
    const menu =
      'cursor agent\n→ fix it\nrun this command?\n→ run (once) (y)\n  skip & tell the agent (esc or n)'
    expect(detectTerminalWaitBlockedReason(menu)).toBe('agent-approval-prompt')
    expect(detectTerminalWaitBlockedReason(menu.split('\n').slice(0, -1).join('\n'))).toBeNull()
  })
})

describe('the blocked layer prefilter', () => {
  it('includes every bundled blocked anchor', () => {
    expect(TERMINAL_WAIT_BLOCKED_SENTINEL_RE.test('Run this command?')).toBe(true)
  })
})
