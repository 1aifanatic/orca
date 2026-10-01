import { findDuplicateClaudeAccount, normalizeClaudeEmail } from './claude-duplicate-account'
import { findClaudeAccountIdentityIssues } from './claude-account-identity'
import { randomUUID } from 'node:crypto'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { RateLimitService } from '../rate-limits/service'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import type { ClaudeAccountSelection } from './claude-account-selection'
import type { ClaudeRuntimeAuthService } from './runtime-auth-service'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'
import { getClaudeSelectionTargetForAccount } from './runtime-selection'
import { getClaudeProfileRoutingAuthority } from './claude-profile-routing-authority'
import type { ClaudeLoginIdentity } from './claude-profile-readiness'
import {
  prepareClaudeProfileLogin,
  loginToClaudeProfile,
  readClaudeProfileLoginIdentity
} from './claude-profile-login'

export class ClaudeAccountRegistration {
  constructor(
    private readonly deps: {
      store: {
        getSettings: () => Pick<
          GlobalSettings,
          'claudeManagedAccounts' | 'agentStatusHooksEnabled' | 'disabledTuiAgents'
        >
        updateSettings: (patch: Pick<GlobalSettings, 'claudeManagedAccounts'>) => unknown
      }
      rateLimits: Pick<
        RateLimitService,
        'evictInactiveClaudeCache' | 'refreshForClaudeAccountChange'
      >
      runtimeAuth: Pick<ClaudeRuntimeAuthService, 'syncForCurrentSelection'>
      selection: Pick<ClaudeAccountSelection, 'requireAccount' | 'list'>
      setCancel: (cancel: (() => boolean) | null) => void
      prepare?: typeof prepareClaudeProfileLogin
      login?: typeof loginToClaudeProfile
      readIdentity?: typeof readClaudeProfileLoginIdentity
      observeIdentity?: (
        accountId: string,
        target: ClaudeAccountSelectionTarget
      ) => Promise<ClaudeLoginIdentity | null>
    }
  ) {}

  private async createDraft(target: ClaudeAccountSelectionTarget = { runtime: 'host' }) {
    if (target.runtime === 'wsl' && !target.wslDistro) {
      throw new Error('Choose a WSL distro before signing in.')
    }
    const now = Date.now()
    const account: ClaudeManagedAccount = {
      id: randomUUID(),
      email: '',
      managedAuthPath: '',
      managedAuthRuntime: target.runtime ?? 'host',
      wslDistro: target.wslDistro ?? null,
      authMethod: 'unknown',
      createdAt: now,
      updatedAt: now,
      lastAuthenticatedAt: 0
    }
    // A cancelled or interrupted login remains listed so the user can retry or forget it.
    this.save(account)
    await this.publish(target)
    return account.id
  }

  async begin(target: ClaudeAccountSelectionTarget = { runtime: 'host' }, accountId?: string) {
    const id = accountId ?? (await this.createDraft(target))
    const account = this.deps.selection.requireAccount(id)
    let prepared: Awaited<ReturnType<typeof prepareClaudeProfileLogin>>
    try {
      prepared = await (this.deps.prepare ?? prepareClaudeProfileLogin)(
        id,
        getClaudeSelectionTargetForAccount(account),
        this.deps.store.getSettings()
      )
    } catch (error) {
      // Why: no Claude process ran, so a new draft holds nothing to retry; forget only the row.
      if (!accountId) {
        this.forget(id)
        await this.publish(target)
      }
      throw error
    }
    // Why repoint the legacy fields: an older Orca's ownership checks refuse this path, so a
    // downgrade falls back to System Default instead of resuming its legacy token replay.
    this.save({
      ...account,
      managedAuthPath: prepared.config.windowsPath,
      wslLinuxAuthPath: prepared.config.linuxPath
    })
    return { accountId: id, config: prepared.config }
  }

  async add(target?: ClaudeAccountSelectionTarget) {
    const draft = await this.begin(target)
    return this.login(draft.accountId, draft.config)
  }

  async reauthenticate(accountId: string) {
    const draft = await this.begin(undefined, accountId)
    return this.login(accountId, draft.config)
  }

  private async login(accountId: string, config: Parameters<typeof loginToClaudeProfile>[0]) {
    await (this.deps.login ?? loginToClaudeProfile)(config, this.deps.setCancel)
    return this.finish(accountId)
  }

  async finish(accountId: string) {
    const { store, rateLimits, selection } = this.deps
    const account = selection.requireAccount(accountId)
    const target = getClaudeSelectionTargetForAccount(account)
    const prepared = await (this.deps.prepare ?? prepareClaudeProfileLogin)(
      accountId,
      target,
      store.getSettings()
    )
    const identity = await this.readIdentity(accountId, target, prepared.config)
    const takenByAnother = findDuplicateClaudeAccount(
      store.getSettings().claudeManagedAccounts.filter((entry) => entry.id !== accountId),
      {
        email: identity.email,
        organizationUuid: identity.organizationUuid ?? null,
        managedAuthRuntime: account.managedAuthRuntime ?? 'host',
        wslDistro: account.wslDistro ?? null
      }
    )
    // Why keep the label: signing a row in to a login another row owns must not take that
    // row's identity; the row then shows what it holds and is flagged instead.
    const keepsLabel =
      Boolean(account.email) &&
      takenByAnother !== null &&
      normalizeClaudeEmail(account.email) !== normalizeClaudeEmail(identity.email)
    this.save({
      ...account,
      ...(keepsLabel
        ? {}
        : {
            email: identity.email,
            organizationUuid: identity.organizationUuid ?? null,
            organizationName: identity.organizationName ?? null
          }),
      authMethod: 'subscription-oauth',
      updatedAt: Date.now(),
      lastAuthenticatedAt: Date.now()
    })
    rateLimits.evictInactiveClaudeCache(accountId)
    await this.publish(target)
    void rateLimits
      .refreshForClaudeAccountChange(undefined, target)
      .catch((error) => console.warn('[claude-profile] Usage unavailable after sign-in:', error))
    const profiles = getClaudeProfileRoutingAuthority()
    const issue = findClaudeAccountIdentityIssues(
      store.getSettings().claudeManagedAccounts.map((entry) => ({
        ...entry,
        observed: entry.id === accountId ? identity : (profiles?.observedIdentity(entry.id) ?? null)
      }))
    ).get(accountId)
    if (issue === 'duplicate') {
      throw new Error(
        keepsLabel
          ? `Signed in as ${identity.email}, which is already added as another account. Sign in again as ${account.email}, or remove this row.`
          : `${identity.email} is already added as another account. Remove this row, or sign in again with a different account.`
      )
    }
    return selection.list()
  }

  // Why the fallback: status output can mix in stderr or omit the email, while Claude's own
  // state file in the profile still names the login that just finished.
  private async readIdentity(
    accountId: string,
    target: ClaudeAccountSelectionTarget,
    config: Parameters<typeof readClaudeProfileLoginIdentity>[0]
  ): Promise<ClaudeLoginIdentity> {
    try {
      const status = await (this.deps.readIdentity ?? readClaudeProfileLoginIdentity)(config)
      return {
        email: status.email,
        organizationUuid: status.organizationUuid ?? null,
        organizationName: status.organizationName ?? null
      }
    } catch (error) {
      const observed = await (this.deps.observeIdentity ?? observeClaudeProfileIdentity)(
        accountId,
        target
      )
      if (observed) {
        return observed
      }
      console.warn('[claude-profile] Could not read the signed-in Claude account:', error)
      throw new Error(
        'Claude sign-in finished, but Orca could not tell which account it used. Try Sign in again.'
      )
    }
  }

  private async publish(target: ClaudeAccountSelectionTarget): Promise<void> {
    try {
      await this.deps.runtimeAuth.syncForCurrentSelection(target, 'boot')
    } catch (error) {
      // Publication reports its own UI issue; a stale selection must not block signing in.
      console.warn('[claude-profile] Account selection publication failed:', error)
    }
  }

  private forget(accountId: string): void {
    this.deps.store.updateSettings({
      claudeManagedAccounts: this.deps.store
        .getSettings()
        .claudeManagedAccounts.filter((entry) => entry.id !== accountId)
    })
  }

  private save(account: ClaudeManagedAccount): void {
    const accounts = this.deps.store.getSettings().claudeManagedAccounts
    this.deps.store.updateSettings({
      claudeManagedAccounts: [...accounts.filter((entry) => entry.id !== account.id), account]
    })
  }
}

/** Re-reads the account's profile; a WSL guest is asked only while it is running. */
async function observeClaudeProfileIdentity(
  accountId: string,
  target: ClaudeAccountSelectionTarget
): Promise<ClaudeLoginIdentity | null> {
  const profiles = getClaudeProfileRoutingAuthority()
  try {
    await profiles?.refreshForRead(target)
  } catch {
    // The account's readiness carries why its profile could not be read.
  }
  return profiles?.observedIdentity(accountId) ?? null
}
