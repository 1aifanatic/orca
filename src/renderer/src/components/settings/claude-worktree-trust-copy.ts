import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

export function getClaudeWorktreeTrustTitle(): string {
  return translate(
    'auto.components.settings.claude-worktree-trust-copy.title',
    'Trust worktrees Orca creates for Claude'
  )
}

export function getClaudeWorktreeTrustDescription(): string {
  return translate(
    'auto.components.settings.claude-worktree-trust-copy.description',
    'When Orca starts Claude in a worktree it created, Claude skips its "trust this folder?" prompt, so the repo\'s Claude hooks and settings run without asking first. Claude still asks in folders and checkouts you added yourself, and in worktrees of pull requests from forks.'
  )
}

export function getClaudeWorktreeTrustSearchKeywords(): string[] {
  return searchKeywords([
    { key: 'auto.components.settings.agents.search.claude-trust-trust', fallback: 'trust' },
    { key: 'auto.components.settings.agents.search.claude-trust-folder', fallback: 'folder' },
    { key: 'auto.components.settings.agents.search.claude-trust-worktree', fallback: 'worktree' },
    { key: 'auto.components.settings.agents.search.c64059f50d', fallback: 'prompt' },
    { key: 'auto.components.settings.agents.search.0d752916f8', fallback: 'hooks' },
    {
      key: 'auto.components.settings.agents.search.f412abbba5',
      fallback: 'claude',
      englishOnly: true
    }
  ])
}
