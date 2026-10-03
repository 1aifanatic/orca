import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { removeHostTree } from '../host-tree-removal'
import type {
  ManagedDataAccountProvider,
  ManagedDataAccountsState
} from '../../shared/managed-account-types'
import { writeSecureFile } from '../../shared/secure-file'

export class ManagedDataAccountProfileRemoval {
  constructor(
    private readonly root: string,
    private readonly assertOwned: (path: string) => void,
    private readonly removeDirectory: (directory: string) => void | Promise<void> = removeHostTree
  ) {}

  async remove(
    provider: ManagedDataAccountProvider,
    accountId: string,
    state: ManagedDataAccountsState,
    publish: (state: ManagedDataAccountsState) => ManagedDataAccountsState,
    changed: () => void
  ): Promise<ManagedDataAccountsState> {
    if (!z.uuid().safeParse(accountId).success) {
      throw new Error('Managed account not found.')
    }
    const directory = join(this.root, provider, accountId)
    const pendingDirectory = join(this.root, provider, '.pending-delete', accountId)
    const metadataPath = join(this.root, provider, 'accounts.json')
    const rollbackPath = `${metadataPath}.${accountId}.rollback`
    if (!state.accounts.some((account) => account.id === accountId)) {
      if (existsSync(rollbackPath) && existsSync(directory)) {
        this.assertOwned(rollbackPath)
        this.quarantine(directory, pendingDirectory)
        changed()
      } else if (!existsSync(pendingDirectory)) {
        throw new Error('Managed account not found.')
      }
      this.discardBackup(rollbackPath)
      await this.cleanup(pendingDirectory)
      return state
    }
    if (existsSync(rollbackPath)) {
      this.assertOwned(rollbackPath)
    }
    if (!writeSecureFile(rollbackPath, readFileSync(metadataPath, 'utf8'), { durable: true })) {
      rmSync(rollbackPath, { force: true })
      throw new Error('Could not restrict account metadata backup permissions.')
    }
    let next: ManagedDataAccountsState
    try {
      next = publish({
        accounts: state.accounts.filter((account) => account.id !== accountId),
        activeAccountId: state.activeAccountId === accountId ? null : state.activeAccountId
      })
      this.quarantine(directory, pendingDirectory)
    } catch (error) {
      try {
        renameSync(rollbackPath, metadataPath)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Account removal failed and its private metadata backup could not be restored; retry removal to recover.',
          { cause: error }
        )
      }
      throw error
    }
    this.discardBackup(rollbackPath)
    changed()
    // Cleanup can partially delete a tree, so it must never roll back a committed removal.
    await this.cleanup(pendingDirectory)
    return next
  }

  private quarantine(directory: string, pendingDirectory: string): void {
    if (!existsSync(directory)) {
      return
    }
    this.assertOwned(directory)
    if (existsSync(pendingDirectory)) {
      throw new Error('Account already has a pending removal directory.')
    }
    const pendingRoot = dirname(pendingDirectory)
    mkdirSync(pendingRoot, { recursive: true, mode: 0o700 })
    this.assertOwned(pendingRoot)
    renameSync(directory, pendingDirectory)
  }

  private discardBackup(rollbackPath: string): void {
    try {
      rmSync(rollbackPath, { force: true })
    } catch {
      console.warn('[managed-data-accounts] Could not remove account metadata backup.')
    }
  }

  private async cleanup(directory: string): Promise<void> {
    if (!existsSync(directory)) {
      return
    }
    try {
      this.assertOwned(dirname(directory))
      this.assertOwned(directory)
      await this.removeDirectory(directory)
    } catch {
      console.warn(
        '[managed-data-accounts] Account removed; private directory cleanup is deferred.'
      )
    }
  }

  async retry(provider: ManagedDataAccountProvider, registered: Set<string>): Promise<void> {
    const pendingRoot = join(this.root, provider, '.pending-delete')
    if (!existsSync(pendingRoot)) {
      return
    }
    try {
      this.assertOwned(pendingRoot)
      const entries = await readdir(pendingRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (
          !entry.isDirectory() ||
          !z.uuid().safeParse(entry.name).success ||
          registered.has(entry.name)
        ) {
          continue
        }
        await this.cleanup(join(pendingRoot, entry.name))
        this.discardBackup(join(this.root, provider, `accounts.json.${entry.name}.rollback`))
      }
    } catch {
      console.warn('[managed-data-accounts] Could not retry private account directory cleanup.')
    }
  }
}
