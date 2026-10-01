import type {
  ClaudeManagedAccount,
  ClaudeManagedAccountSummary,
  ClaudeProfileReadiness,
  ClaudeSystemDefaultIdentity
} from '../../shared/managed-account-types'
import { findDuplicateClaudeAccount, normalizeClaudeEmail } from './claude-duplicate-account'
import type { ClaudeLoginIdentity } from './claude-profile-readiness'

export type ClaudeObservedAccount = Pick<
  ClaudeManagedAccount,
  'id' | 'email' | 'organizationUuid' | 'managedAuthRuntime' | 'wslDistro' | 'lastAuthenticatedAt'
> & { observed: { email: string; organizationUuid: string | null } | null }

export type ClaudeAccountIdentityIssue = 'mismatch' | 'duplicate'

/**
 * Compares each row's stored identity with the login its profile actually holds. Exactly one row
 * per login stays clean: a row whose profile matches its label outranks one that does not, a
 * signed-in row outranks an unfinished one, then the earlier sign-in wins.
 */
export function findClaudeAccountIdentityIssues(
  accounts: readonly ClaudeObservedAccount[]
): Map<string, ClaudeAccountIdentityIssue> {
  const consistent = (account: ClaudeObservedAccount) =>
    !account.observed ||
    !account.email ||
    (normalizeClaudeEmail(account.observed.email) === normalizeClaudeEmail(account.email) &&
      (!account.organizationUuid ||
        !account.observed.organizationUuid ||
        account.organizationUuid === account.observed.organizationUuid))
  const rank = (account: ClaudeObservedAccount) => [
    consistent(account) ? 0 : 1,
    account.email ? 0 : 1,
    account.lastAuthenticatedAt
  ]
  const outranks = (left: ClaudeObservedAccount, right: ClaudeObservedAccount) => {
    const [a, b] = [rank(left), rank(right)]
    const differs = a.findIndex((value, index) => value !== b[index])
    return differs === -1 ? left.id < right.id : a[differs] < b[differs]
  }
  const effective = (account: ClaudeObservedAccount) => ({
    email: account.observed?.email ?? account.email,
    organizationUuid: account.observed
      ? account.observed.organizationUuid
      : (account.organizationUuid ?? null),
    managedAuthRuntime: account.managedAuthRuntime ?? 'host',
    wslDistro: account.wslDistro ?? null
  })
  const issues = new Map<string, ClaudeAccountIdentityIssue>()
  for (const account of accounts) {
    const others = accounts
      .filter((entry) => entry.id !== account.id && outranks(entry, account))
      .map(effective)
    if (findDuplicateClaudeAccount(others, effective(account))) {
      issues.set(account.id, 'duplicate')
    } else if (!consistent(account)) {
      issues.set(account.id, 'mismatch')
    }
  }
  return issues
}

/** Plain refusal for selecting a row whose profile holds a different login. */
export function describeClaudeAccountIdentityIssue(
  issue: ClaudeAccountIdentityIssue,
  observedEmail: string
): string {
  return issue === 'duplicate'
    ? `This account is signed in as ${observedEmail}, which is already added as another account. Sign in again with a different account, or remove this row.`
    : `This account is signed in as ${observedEmail}. Sign in again to choose the account it uses, or remove this row.`
}

/** Adds each row's readiness and the login its profile holds; derived on every read. */
export function withObservedClaudeIdentities(
  accounts: readonly ClaudeManagedAccountSummary[],
  owner: {
    readiness: (accountId: string) => ClaudeProfileReadiness
    identity?: (accountId: string) => ClaudeLoginIdentity | null
  }
): ClaudeManagedAccountSummary[] {
  const observed = accounts.map((account) => {
    const profileReadiness = owner.readiness(account.id)
    const identity = profileReadiness === 'ready' ? (owner.identity?.(account.id) ?? null) : null
    return { ...account, profileReadiness, observed: identity }
  })
  const issues = findClaudeAccountIdentityIssues(observed)
  return observed.map(({ observed: identity, ...account }) => {
    const profileIdentityIssue = issues.get(account.id)
    return {
      ...account,
      ...(identity ? { profileEmail: identity.email } : {}),
      ...(profileIdentityIssue ? { profileIdentityIssue } : {})
    }
  })
}

/** System Default's login, flagged when an earlier Orca left a saved account's login there. */
export function describeClaudeSystemDefault(
  identity: ClaudeLoginIdentity | null,
  accounts: readonly Pick<ClaudeManagedAccountSummary, 'email' | 'profileEmail'>[]
): ClaudeSystemDefaultIdentity {
  const email = normalizeClaudeEmail(identity?.email)
  return {
    email: identity?.email ?? null,
    leftByEarlierOrca:
      email !== null &&
      accounts.some(
        (account) =>
          normalizeClaudeEmail(account.email) === email ||
          normalizeClaudeEmail(account.profileEmail) === email
      )
  }
}
