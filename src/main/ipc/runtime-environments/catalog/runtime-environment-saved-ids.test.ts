import '../../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../../shared/testing/remove-temp-dirs.test-support'
import { getEnvironmentStorePath } from '../../../../shared/remote-runtime/host-store/runtime-environment-store-records'
import { readSavedRuntimeEnvironmentIds } from './runtime-environment-saved-ids'

describe('readSavedRuntimeEnvironmentIds', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-saved-ids-'))
  })
  afterEach(async () => {
    await removeTempDirs([userDataPath])
  })

  it('reads a never-written registry as empty only when asked to', async () => {
    await expect(readSavedRuntimeEnvironmentIds(userDataPath)).resolves.toBeNull()
    await expect(
      readSavedRuntimeEnvironmentIds(userDataPath, { requireStoreFile: false })
    ).resolves.toEqual(new Set())
  })

  it('still cannot prove removals from a crash-zeroed registry', async () => {
    writeFileSync(getEnvironmentStorePath(userDataPath), '\0\0\0\0')

    await expect(
      readSavedRuntimeEnvironmentIds(userDataPath, { requireStoreFile: false })
    ).resolves.toBeNull()
  })
})
