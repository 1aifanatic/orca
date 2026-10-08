import { describe, expect, it } from 'vitest'
import { getChatUiSearchEntries, getChatSearchEntry } from './chat-search'
import { matchesSettingsSearch } from './settings-search'

describe('Chat UI settings search', () => {
  it.each(['claude', 'codex'])('matches the built-in structured-agent keyword %s', (query) => {
    expect(matchesSettingsSearch(query, getChatSearchEntry('chat-ui'))).toBe(true)
  })

  it.each(['openclaude', 'grok', 'omp'])(
    'does not suggest the legacy terminal chat parser for %s',
    (query) => {
      expect(matchesSettingsSearch(query, getChatSearchEntry('chat-ui'))).toBe(false)
    }
  )

  it('indexes one entry per row, in pane order', () => {
    expect(getChatUiSearchEntries().map((entry) => entry.id)).toEqual([
      'chat-ui',
      'chat-queue-follow-ups',
      'chat-resume-on-restart',
      'chat-shell-environment'
    ])
  })

  it('finds the child rows by their own copy', () => {
    const entries = getChatUiSearchEntries()
    expect(matchesSettingsSearch('queue follow-ups', entries)).toBe(true)
    expect(matchesSettingsSearch('restart', entries)).toBe(true)
    expect(matchesSettingsSearch('shell environment', entries)).toBe(true)
    expect(matchesSettingsSearch('variables', entries)).toBe(true)
  })

  it('no longer describes Chat UI as experimental', () => {
    expect(matchesSettingsSearch('experimental', getChatUiSearchEntries())).toBe(false)
    expect(getChatSearchEntry('chat-ui').description).not.toMatch(/preview/i)
  })

  it('drops the host-owned rows for web clients', () => {
    const entries = getChatUiSearchEntries({ includeHostOwnedRows: false })
    expect(entries.map((entry) => entry.id)).toEqual(['chat-ui'])
    expect(matchesSettingsSearch('restart', entries)).toBe(false)
    expect(matchesSettingsSearch('shell environment', entries)).toBe(false)
  })

  it('indexes only the enable switch while Chat UI is off', () => {
    expect(getChatUiSearchEntries({ includeEnabledRows: false }).map((entry) => entry.id)).toEqual([
      'chat-ui'
    ])
  })
})
