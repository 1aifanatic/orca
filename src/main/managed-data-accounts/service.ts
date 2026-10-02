import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { getAppEnvironment } from '../../shared/app-environment'
import { writeSecureFile } from '../../shared/secure-file'
import type {
  ManagedDataAccountProvider,
  ManagedDataAccountsState
} from '../../shared/managed-account-types'
import { captureDataAccountCredentials } from './credential-capture'

const stateSchema = z.object({
  accounts: z
    .array(
      z.object({
        id: z.uuid(),
        label: z.string().min(1).max(120),
        integrations: z.array(z.string()).max(64),
        createdAt: z.number()
      })
    )
    .max(64),
  activeAccountId: z.uuid().nullable()
})

export class ManagedDataAccountService {
  private pending: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly root: string) {}

  list(provider: ManagedDataAccountProvider): ManagedDataAccountsState {
    const path = join(this.root, provider, 'accounts.json')
    if (!existsSync(path)) {
      return { accounts: [], activeAccountId: null }
    }
    this.assertOwned(path)
    return stateSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  }

  add(
    provider: ManagedDataAccountProvider,
    sourceDataHome: string,
    label: string
  ): Promise<ManagedDataAccountsState> {
    return this.mutate(async () => {
      const state = this.list(provider)
      if (state.accounts.length >= 64) {
        throw new Error('Managed account limit reached.')
      }
      const id = randomUUID()
      const directory = join(this.root, provider, id)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      this.assertOwned(directory)
      try {
        const integrations = await captureDataAccountCredentials(
          provider,
          sourceDataHome,
          join(directory, 'data')
        )
        return this.persist(provider, {
          accounts: [...state.accounts, { id, label, integrations, createdAt: Date.now() }],
          activeAccountId: id
        })
      } catch (error) {
        rmSync(directory, { recursive: true, force: true })
        throw error
      }
    })
  }

  select(
    provider: ManagedDataAccountProvider,
    accountId: string | null
  ): Promise<ManagedDataAccountsState> {
    return this.mutate(async () => {
      const state = this.list(provider)
      if (accountId !== null) {
        this.requireAccount(provider, accountId)
      }
      return this.persist(provider, { ...state, activeAccountId: accountId })
    })
  }

  remove(
    provider: ManagedDataAccountProvider,
    accountId: string
  ): Promise<ManagedDataAccountsState> {
    return this.mutate(async () => {
      const state = this.list(provider)
      this.requireAccount(provider, accountId)
      const result = this.persist(provider, {
        accounts: state.accounts.filter((account) => account.id !== accountId),
        activeAccountId: state.activeAccountId === accountId ? null : state.activeAccountId
      })
      const directory = join(this.root, provider, accountId)
      this.assertOwned(directory)
      rmSync(directory, { recursive: true, force: true })
      return result
    })
  }

  launchEnvironment(provider: ManagedDataAccountProvider): Record<string, string> {
    const state = this.list(provider)
    if (!state.activeAccountId) {
      return {}
    }
    return this.profileEnvironment(provider, state.activeAccountId)
  }

  transcriptEnvironments(provider: ManagedDataAccountProvider): Record<string, string>[] {
    const state = this.list(provider)
    const selected = state.accounts.filter((account) => account.id === state.activeAccountId)
    const others = state.accounts.filter((account) => account.id !== state.activeAccountId)
    return [...selected, ...others].map((account) => this.profileEnvironment(provider, account.id))
  }

  private profileEnvironment(
    provider: ManagedDataAccountProvider,
    accountId: string
  ): Record<string, string> {
    const directory = this.requireAccount(provider, accountId)
    return {
      XDG_DATA_HOME: join(directory, 'data'),
      XDG_STATE_HOME: join(directory, 'state'),
      ...(provider === 'opencode' ? { OPENCODE_DB: 'opencode.db', OPENCODE_AUTH_CONTENT: '' } : {})
    }
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private requireAccount(provider: ManagedDataAccountProvider, id: string): string {
    if (!this.list(provider).accounts.some((account) => account.id === id)) {
      throw new Error('Managed account not found.')
    }
    const directory = join(this.root, provider, id)
    this.assertOwned(directory)
    return directory
  }

  private persist(
    provider: ManagedDataAccountProvider,
    state: ManagedDataAccountsState
  ): ManagedDataAccountsState {
    const checked = stateSchema.parse(state)
    const path = join(this.root, provider, 'accounts.json')
    if (existsSync(path)) {
      this.assertOwned(path)
    }
    if (!writeSecureFile(path, JSON.stringify(checked))) {
      throw new Error('Could not restrict account metadata permissions.')
    }
    for (const listener of this.listeners) {
      listener()
    }
    return checked
  }

  private assertOwned(path: string): void {
    if (
      lstatSync(this.root).isSymbolicLink() ||
      lstatSync(path).isSymbolicLink() ||
      !realpathSync(path).startsWith(realpathSync(this.root) + sep)
    ) {
      throw new Error('Managed account path is outside Orca account storage.')
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation)
    this.pending = next.catch(() => {})
    return next
  }
}

let instance: { root: string; service: ManagedDataAccountService } | undefined

export function getManagedDataAccountService(): ManagedDataAccountService {
  const root = resolve(getAppEnvironment().getPath('userData'), 'managed-data-accounts')
  if (instance?.root !== root) {
    instance = { root, service: new ManagedDataAccountService(root) }
  }
  return instance.service
}
