import { translate } from '@/i18n/i18n'
import { matchesSettingsSearch } from './settings-search'

export function automaticReviewRefreshSearchEntry() {
  return {
    title: translate('settings.git.automaticReviewRefresh.title', 'Automatic Review Refresh'),
    description: translate(
      'settings.git.automaticReviewRefresh.description',
      'Periodically refresh pull requests, merge requests, and checks. Turn off to reduce server requests. Opening a workspace, pushing, and manual refresh still fetch the latest status.'
    ),
    keywords: ['polling', 'background', 'GitHub', 'GitLab', 'checks', 'rate limit', 'Enterprise']
  }
}

export function automaticReviewRefreshMatchesSearch(query: string): boolean {
  return matchesSettingsSearch(query, automaticReviewRefreshSearchEntry())
}
