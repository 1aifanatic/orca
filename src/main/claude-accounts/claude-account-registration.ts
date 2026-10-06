import { randomUUID } from 'node:crypto'
import type {
  ClaudeAccountSignIn,
  ClaudeRateLimitAccountsState
} from '../../shared/managed-account-types'
import { claudeStateFile, readClaudeFolderLogin } from './claude-account-folder'
import type {
  ClaudeAccountRuntime,
  ClaudeAccountSelection,
  ClaudeAccountStore,
  ClaudeAccountUsage
} from './claude-account-selection'
import { findDuplicateClaudeAccount } from './claude-duplicate-account'
import {
  getClaudeSelectionTargetForAccount,
  normalizeClaudeAccountSelectionTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'

export const CLAUDE_SIGN_IN_NOT_FINISHED_MESSAGE =
  'Claude has not finished signing in to this account yet. Finish the sign-in in the terminal, then try again.'

/**
 * Sign-in runs `claude auth login` against the account's folder in a terminal the user sees
 * (superset AddAccountDialog). A folder becomes an account only once it holds a login
 * (superset U/profiles.ts:132,178), so an abandoned sign-in never shows as a row.
 */
export class ClaudeAccountRegistration {
  constructor(
    private readonly deps: {
      store: ClaudeAccountStore
      rateLimits: ClaudeAccountUsage
      runtimeAuth: ClaudeAccountRuntime
      selection: ClaudeAccountSelection
    }
  ) {}

  /** A new folder, or a saved account's own folder when `accountId` is given. */
  async begin(
    request: ClaudeAccountSelectionTarget & { accountId?: string }
  ): Promise<ClaudeAccountSignIn> {
    const saved = request.accountId ? this.deps.selection.requireAccount(request.accountId) : null
    const target = saved ? getClaudeSelectionTargetForAccount(saved) : signInTarget(request)
    const accountId = saved?.id ?? randomUUID()
    const folder = await this.deps.runtimeAuth.prepareAccountFolder(accountId, target)
    return { accountId, configDir: folder.configDir, ...target }
  }

  async finish(
    signIn: Omit<ClaudeAccountSignIn, 'configDir'>
  ): Promise<ClaudeRateLimitAccountsState> {
    const { store, rateLimits, runtimeAuth, selection } = this.deps
    const saved = selection.findAccount(signIn.accountId)
    const target = saved ? getClaudeSelectionTargetForAccount(saved) : signInTarget(signIn)
    // Why set up again: onboarding is merged only into a state file the login just created.
    const folder = await runtimeAuth.prepareAccountFolder(signIn.accountId, target)
    const login = readClaudeFolderLogin(claudeStateFile(folder.readPath))
    if (!login) {
      throw new Error(CLAUDE_SIGN_IN_NOT_FINISHED_MESSAGE)
    }
    const accounts = store.getSettings().claudeManagedAccounts
    const scope = {
      managedAuthRuntime: target.runtime ?? 'host',
      wslDistro: target.runtime === 'wsl' ? (target.wslDistro ?? null) : null
    } as const
    if (
      !saved &&
      findDuplicateClaudeAccount(accounts, {
        email: login.email,
        organizationUuid: login.organizationUuid,
        ...scope
      })
    ) {
      await runtimeAuth.removeAccountFolder(signIn.accountId, target)
      throw new Error('This Claude account is already added.')
    }
    const now = Date.now()
    selection.saveSettings({
      claudeManagedAccounts: [
        ...accounts.filter((entry) => entry.id !== signIn.accountId),
        {
          id: signIn.accountId,
          email: login.email,
          organizationUuid: login.organizationUuid,
          organizationName: login.organizationName,
          managedAuthPath: folder.readPath,
          ...scope,
          wslLinuxAuthPath: target.runtime === 'wsl' ? folder.configDir : null,
          authMethod: 'subscription-oauth',
          createdAt: saved?.createdAt ?? now,
          updatedAt: now,
          lastAuthenticatedAt: now
        }
      ]
    })
    rateLimits.evictInactiveClaudeCache(signIn.accountId)
    // Why publish: a selected account's terminals follow its folder only once it exists.
    await runtimeAuth.syncForCurrentSelection(target)
    selection.refreshUsage(undefined, target)
    return selection.list()
  }
}

function signInTarget(request: ClaudeAccountSelectionTarget): ClaudeAccountSelectionTarget {
  const target = normalizeClaudeAccountSelectionTarget(request)
  if (target.runtime === 'wsl' && !target.wslDistro) {
    throw new Error('Choose a WSL distro before signing in.')
  }
  return target.runtime === 'wsl'
    ? { runtime: 'wsl', wslDistro: target.wslDistro }
    : { runtime: 'host' }
}
