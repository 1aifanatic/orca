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
          : readiness === 'unverified'
            ? translate(
                'accounts.claude.wslNotRunning',
                '{{value0}} is not running, so this account has not been checked yet. Selecting it starts {{value0}}.',
                { value0: account.wslDistro || 'WSL' }
              )
            : readiness === 'unavailable'
              ? account.managedAuthRuntime === 'wsl'
                ? translate(
                    'accounts.claude.wslUnavailable',
                    'Orca could not check this account in {{value0}}. Select it to try again, or sign in again.',
                    { value0: account.wslDistro || 'WSL' }
                  )
                : translate(
                    'accounts.claude.profileUnreadable',
                    "This account's files could not be read. Try again, or sign in again."
                  )
              : null
  return {
    label,
    problem,
    // Why these pass: an older host reports no readiness, and selecting a WSL account starts its
    // distro and checks it, refusing with its own reason if it still cannot be used.
    selectable:
      (readiness === undefined ||
        readiness === 'ready' ||
        (account.managedAuthRuntime === 'wsl' &&
          (readiness === 'unverified' || readiness === 'unavailable'))) &&
      !account.profileIdentityIssue
  }
}
