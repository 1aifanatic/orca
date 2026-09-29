import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

export function getCodexTerminalServerIsolationTitle(): string {
  return translate(
    'settings.agents.codexTerminalServerIsolation.title',
    'Run each Codex terminal on its own server'
  )
}

export function getCodexTerminalServerIsolationDescription(): string {
  return translate(
    'settings.agents.codexTerminalServerIsolation.description',
    "Keeps Orca's status and closing tabs working correctly. Turn off to use Codex's shared server and its agents overview. Applies to new terminals."
  )
}

export function getCodexTerminalServerIsolationSearchKeywords(): string[] {
  return searchKeywords([
    {
      key: 'auto.components.settings.agents.search.5ded38b843',
      fallback: 'codex',
      englishOnly: true
    },
    { key: 'settings.agents.codexTerminalServerIsolation.search.server', fallback: 'server' },
    { key: 'settings.agents.codexTerminalServerIsolation.search.daemon', fallback: 'daemon' },
    { key: 'settings.agents.codexTerminalServerIsolation.search.shared', fallback: 'shared' },
    { key: 'settings.agents.codexTerminalServerIsolation.search.isolate', fallback: 'isolate' },
    {
      key: 'settings.agents.codexTerminalServerIsolation.search.agentsOverview',
      fallback: 'agents overview'
    },
    { key: 'auto.components.settings.agents.search.6984d4291a', fallback: 'status' }
  ])
}
