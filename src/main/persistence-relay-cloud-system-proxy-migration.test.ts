import { closeTestStores, testState, createStore, writeDataFile } from './persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

// Why: existing installs must keep their working direct relay route; only new installs start proxied.
describe('relayAndCloudUseSystemProxy cohort default', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('turns the proxy route on for a fresh install and keeps it on after restart', async () => {
    const store = createStore()
    expect(store.getSettings().relayAndCloudUseSystemProxy).toBe(true)
    store.flush()

    expect(createStore().getSettings().relayAndCloudUseSystemProxy).toBe(true)
  })

  it('keeps an existing install on the direct route', () => {
    writeDataFile({ schemaVersion: 1, settings: { theme: 'dark' }, ui: {} })

    expect(createStore().getSettings().relayAndCloudUseSystemProxy).toBe(false)
  })

  it('preserves an explicit choice', () => {
    writeDataFile({ schemaVersion: 1, settings: { relayAndCloudUseSystemProxy: true }, ui: {} })

    expect(createStore().getSettings().relayAndCloudUseSystemProxy).toBe(true)
  })
})
