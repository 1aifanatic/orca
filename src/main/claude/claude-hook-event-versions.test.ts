import { describe, expect, it } from 'vitest'
import { compareAppVersions } from '../../shared/app-version'
import fixture from './__fixtures__/claude-hook-event-enums.json'
import {
  CLAUDE_HOOK_EVENT_FIRST_VERSIONS,
  CLAUDE_HOOK_EVENT_TABLE_FLOOR,
  claudeKnowsHookEvent,
  parseClaudeCliVersion,
  type ClaudeHookEventName
} from './claude-hook-event-versions'

const enums: Record<string, string[]> = fixture.enums
const previousPublished: Record<string, string> = fixture.previousPublishedVersion
const versions = Object.keys(enums).sort(compareAppVersions)
const isTableEvent = (name: string): name is ClaudeHookEventName =>
  name in CLAUDE_HOOK_EVENT_FIRST_VERSIONS
const tableEntries = Object.keys(CLAUDE_HOOK_EVENT_FIRST_VERSIONS)
  .filter(isTableEvent)
  .map((event): [ClaudeHookEventName, string] => [event, CLAUDE_HOOK_EVENT_FIRST_VERSIONS[event]])

describe('Claude hook event version table', () => {
  it('starts at the oldest release the fixture covers', () => {
    expect(versions[0]).toBe(CLAUDE_HOOK_EVENT_TABLE_FLOOR)
  })

  it.each(tableEntries)('pins %s to the first release whose enum knows it', (event, first) => {
    expect(versions.find((version) => enums[version].includes(event))).toBe(first)
    for (const version of versions) {
      expect(enums[version].includes(event), `${event} in ${version}`).toBe(
        compareAppVersions(version, first) >= 0
      )
    }
    if (first !== CLAUDE_HOOK_EVENT_TABLE_FLOOR) {
      // Why: the release published just before `first` lacks the event, so the table is exact, not just safe.
      const before = previousPublished[first]
      expect(enums[before], `enum for ${before}`).toBeDefined()
      expect(enums[before]).not.toContain(event)
    }
  })
})

describe('claudeKnowsHookEvent', () => {
  it.each([
    ['2.1.77', 'StopFailure', false],
    ['2.1.78 (Claude Code)', 'StopFailure', true],
    ['2.1.75', 'PostCompact', false],
    ['2.1.76', 'PostCompact', true],
    ['2.1.32', 'TeammateIdle', false],
    ['2.0.55', 'PostToolUseFailure', false],
    ['2.0.44', 'PermissionRequest', false],
    ['2.0.42', 'SubagentStart', false],
    ['1.0.84', 'SessionEnd', false],
    ['1.0.81', 'SessionStart', true]
  ] as const)('%s knows %s: %s', (version, event, expected) => {
    expect(claudeKnowsHookEvent(version, event)).toBe(expected)
  })

  it.each([undefined, null, 'unknown'])(
    'grants an unresolved version (%s) only the events every tabled Claude knows',
    (version) => {
      const known = tableEntries
        .filter(([event]) => claudeKnowsHookEvent(version, event))
        .map(([event]) => event)
      expect(known.sort()).toEqual(
        tableEntries
          .filter(([, first]) => first === CLAUDE_HOOK_EVENT_TABLE_FLOOR)
          .map(([event]) => event)
          .sort()
      )
      for (const event of known) {
        expect(enums[CLAUDE_HOOK_EVENT_TABLE_FLOOR]).toContain(event)
      }
    }
  )
})

describe('parseClaudeCliVersion', () => {
  it('extracts Claude Code version output', () => {
    expect(parseClaudeCliVersion('2.1.261 (Claude Code)')).toBe('2.1.261')
    expect(parseClaudeCliVersion('unknown')).toBeNull()
  })
})
