import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { credential, harness } from './native-account-test-fixtures'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-agy-vault-test-'))
  setSecretStore({
    isEncryptionAvailable: () => true,
    describeProtectionGap: () => null,
    encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => {
      if (!value.toString().startsWith('sealed:')) {
        throw new Error('synthetic decrypt failure')
      }
      return Buffer.from(value.toString().slice(7), 'base64').toString()
    }
  })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  _resetSecretStoreForTests()
})

describe('protected Antigravity account snapshots', () => {
  it('persists a selected account with exact provider fields and private permissions across restart', async () => {
    const h = harness()
    const state = await h.service.addCurrentAccount()
    const vault = h.getVault()
    vault.selectedAccountId = state.activeAccountId
    const path = join(dir, 'accounts', 'vault')
    createEncryptedAntigravityAccountStore(path).write(vault)
    expect(readFileSync(path, 'utf8')).not.toContain('synthetic-1')
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o077).toBe(0)
    }
    expect(createEncryptedAntigravityAccountStore(path).read()).toEqual(vault)
    expect(createEncryptedAntigravityAccountStore(path).read().accounts[0].credentials).toBe(
      credential('a')
    )
  })

  it.each([false, true])(
    'refuses unavailable or weak encryption without changing saved bytes (available=%s)',
    async (available) => {
      const h = harness()
      await h.service.addCurrentAccount()
      const path = join(dir, 'vault')
      const store = createEncryptedAntigravityAccountStore(path)
      store.write(h.getVault())
      const before = readFileSync(path)
      setSecretStore({
        isEncryptionAvailable: () => available,
        describeProtectionGap: () => 'unprotected',
        encryptString: () => {
          throw new Error('must not encrypt')
        },
        decryptString: () => {
          throw new Error('must not decrypt')
        }
      })
      expect(() => store.write({ accounts: [], selectedAccountId: null })).toThrow(
        'Protected secret storage'
      )
      expect(() => store.read()).toThrow('Protected secret storage')
      expect(readFileSync(path)).toEqual(before)
    }
  )

  it('keeps an unreadable vault intact rather than treating it as empty', () => {
    const path = join(dir, 'vault')
    writeFileSync(path, 'broken ciphertext', { mode: 0o600 })
    expect(() => createEncryptedAntigravityAccountStore(path).read()).toThrow('preserved')
    expect(readFileSync(path, 'utf8')).toBe('broken ciphertext')
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a broadly readable persisted snapshot',
    async () => {
      const h = harness()
      await h.service.addCurrentAccount()
      const path = join(dir, 'vault')
      const store = createEncryptedAntigravityAccountStore(path)
      store.write(h.getVault())
      chmodSync(path, 0o644)
      expect(() => store.read()).toThrow('preserved')
    }
  )
})
