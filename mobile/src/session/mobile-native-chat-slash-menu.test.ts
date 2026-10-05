import { describe, expect, it } from 'vitest'
import type { AgentSessionSlashCommand } from '../../../src/shared/agent-session-wire'
import { getVerifiedNativeChatCommands } from '../../../src/shared/native-chat-agent-profiles'
import { mobileNativeChatSlashMenu, structuredLaneCommands } from './mobile-native-chat-slash-menu'

const names = (items: readonly { name: string }[]): string[] => items.map(({ name }) => name)

function menu(
  overrides: Partial<Parameters<typeof mobileNativeChatSlashMenu>[0]>
): ReturnType<typeof mobileNativeChatSlashMenu> {
  return mobileNativeChatSlashMenu({
    agent: 'claude',
    structuredCommands: [],
    sessionCommands: undefined,
    query: '',
    ...overrides
  })
}

const CLAUDE_REPORT: AgentSessionSlashCommand[] = [
  { name: 'review', kind: 'command', description: 'Review a pull request', argumentHint: '<pr>' },
  { name: 'init', kind: 'command' },
  { name: 'preview-deploy', kind: 'command', description: 'Ship a preview' },
  { name: 'triage', kind: 'skill', description: 'Sort incoming issues' },
  { name: 'dataviz', kind: 'skill', description: 'Build charts' }
]

describe('mobileNativeChatSlashMenu', () => {
  it('serves an older structured host its host-owned commands, by support', () => {
    const full = menu({ structuredCommands: ['clear', 'compact'] })
    expect(names(full.commands)).toEqual(['model', 'effort', 'clear', 'compact'])
    expect(full.skills).toEqual([])
    expect(full.grouped).toBe(true)
    expect(names(menu({ structuredCommands: ['clear'] }).commands)).toEqual([
      'model',
      'effort',
      'clear'
    ])
    expect(names(menu({ structuredCommands: [] }).commands)).toEqual(['model', 'effort'])
  })

  it('shows the commands and skills a Claude session reports, with their text', () => {
    const result = menu({
      structuredCommands: ['clear', 'compact'],
      sessionCommands: CLAUDE_REPORT
    })
    expect(names(result.commands)).toEqual(['review', 'init', 'preview-deploy'])
    expect(result.commands[0]).toMatchObject({
      kind: 'command',
      token: '/review',
      description: 'Review a pull request',
      argumentHint: '<pr>'
    })
    // Curated text covers a reported name that came without its own.
    expect(result.commands[1]).toMatchObject({ description: 'Initialize a CLAUDE.md' })
    expect(result.skills).toEqual([
      expect.objectContaining({ kind: 'skill', token: '/dataviz', description: 'Build charts' }),
      expect.objectContaining({
        kind: 'skill',
        token: '/triage',
        description: 'Sort incoming issues'
      })
    ])
  })

  it('ranks with the shared policy: exact, prefix, substring, letters, description', () => {
    const result = menu({
      sessionCommands: [
        { name: 'my-review', kind: 'command' },
        { name: 'r-e-v-i-e-w', kind: 'command' },
        { name: 'summarize', kind: 'command', description: 'Write a review summary' },
        { name: 'review-all', kind: 'command' },
        { name: 'review', kind: 'command' },
        { name: 'unrelated', kind: 'command' }
      ],
      query: 'review'
    })
    expect(names(result.commands)).toEqual([
      'review',
      'review-all',
      'my-review',
      'r-e-v-i-e-w',
      'summarize'
    ])
    expect(names(menu({ sessionCommands: CLAUDE_REPORT, query: 'rev' }).commands)).toEqual([
      'review',
      'preview-deploy'
    ])
    expect(names(menu({ sessionCommands: CLAUDE_REPORT, query: 'charts' }).skills)).toEqual([
      'dataviz'
    ])
  })

  it('keeps Codex on its fallback, including /goal, with no skills group', () => {
    const result = menu({ agent: 'codex', structuredCommands: [], sessionCommands: undefined })
    expect(names(result.commands)).toContain('goal')
    expect(result.skills).toEqual([])
    expect(result.grouped).toBe(true)
  })

  it('serves the terminal lane its curated catalog and never session skills', () => {
    const result = menu({
      agent: 'claude',
      structuredCommands: undefined,
      sessionCommands: CLAUDE_REPORT
    })
    expect(names(result.commands)).toEqual(names(getVerifiedNativeChatCommands('claude')))
    expect(result.skills).toEqual([])
  })

  it('is empty without an agent', () => {
    expect(menu({ agent: null })).toEqual({ grouped: false, commands: [], skills: [] })
  })

  it('caps each group at 50 after filtering the whole catalog', () => {
    const sessionCommands = Array.from({ length: 200 }, (_, index) => ({
      name: `cmd-${String(index).padStart(3, '0')}`,
      kind: 'command' as const
    }))
    expect(menu({ sessionCommands }).commands).toHaveLength(50)
    expect(names(menu({ sessionCommands, query: 'cmd-199' }).commands)).toEqual(['cmd-199'])
  })

  it('orders skills by name, since the phone has no disk scope to rank on', () => {
    const result = menu({
      sessionCommands: [
        { name: 'zebra', kind: 'skill' },
        { name: 'alpha', kind: 'skill' }
      ]
    })
    expect(names(result.skills)).toEqual(['alpha', 'zebra'])
  })

  it('leaves an unclassified pre-init name as a command until the session classifies it', () => {
    const result = menu({
      sessionCommands: [{ name: 'project-skill', kind: 'command', kindUnspecified: true }]
    })
    expect(result.commands).toEqual([
      expect.objectContaining({ kind: 'command', name: 'project-skill' })
    ])
    expect(result.skills).toEqual([])
  })

  it('treats an empty report as authoritative instead of reviving the fallback', () => {
    expect(menu({ structuredCommands: ['clear', 'compact'], sessionCommands: [] })).toEqual({
      grouped: true,
      commands: [],
      skills: []
    })
  })

  it('marks the structured lane with a stable command list even before options load', () => {
    expect(structuredLaneCommands(false, ['clear'])).toBeUndefined()
    expect(structuredLaneCommands(true, undefined)).toEqual([])
    expect(structuredLaneCommands(true, undefined)).toBe(structuredLaneCommands(true, undefined))
    const supported = ['clear' as const]
    expect(structuredLaneCommands(true, supported)).toBe(supported)
  })
})
