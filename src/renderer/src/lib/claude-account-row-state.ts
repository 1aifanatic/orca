import { translate } from '@/i18n/i18n'
import type { ClaudeManagedAccountSummary } from '../../../shared/managed-account-types'

export type ClaudeAccountRowState = {
  /** The login the account's profile holds; the stored name only when the profile is unread. */
  label: string
  /** Why the row cannot be used as it is; null for a usable row. */
  problem: string | null
  selectable: boolean
}

/** Shared by Settings and the status-bar switcher so both say the same thing about a row. */
export function getClaudeAccountRowState(
  account: ClaudeManagedAccountSummary
): ClaudeAccountRowState {
  const label =
    account.profileEmail ||
    account.email ||
    translate('accounts.claude.draft', 'Unfinished sign-in')
  const readiness = account.profileReadiness
  const problem =
    account.profileIdentityIssue === 'duplicate'
      ? translate(
          'accounts.claude.identityDuplicate',
          '{{value0}} is already added as another account. Sign in again with a different account, or remove this row.',
          { value0: label }
        )
      : account.profileIdentityIssue === 'mismatch'
        ? translate(
            'accounts.claude.identityMismatch',
            'This account was added as {{value0}} but is now signed in as {{value1}}. Sign in again to choose which account it uses.',
            { value0: account.email, value1: label }
          )
        : readiness === 'sign-in-required'
          ? translate('accounts.claude.signInRequired', 'Sign in again to use this account')
          : readiness === 'unavailable'
            ? translate(
                'accounts.claude.unavailable',
                'Account unavailable. Try again when its host is reachable.'
              )
            : null
  return {
    label,
    problem,
    // Why undefined passes: an older host reports no readiness and still serves every row.
    selectable: (readiness === undefined || readiness === 'ready') && !account.profileIdentityIssue
  }
}
