import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { expect, it } from 'bun:test'
import { nativeFileRealmObservation } from './native-file-realm-observation'
import { getAppEnvironment, setAppEnvironment } from '../../../../../src/shared/app-environment'
import { getSecretStore, setSecretStore } from '../../../../../src/shared/secret-store'
import { takeRealAgentHomeWriteViolations } from '../../../../../config/scripts/vitest-real-agent-home-write-guard'

const file = 'notes/bun-migration/performance/bun-native-five-pure-guard-ci-0bd619-explicit-files/fixtures/host-isolation-a.test.ts'
const slot = Symbol.for('orca.native.guard-isolation-sentinel')
const inherited = Reflect.get(globalThis, slot)
const inheritedModuleFileCount = nativeFileRealmObservation.fileCount
nativeFileRealmObservation.fileCount += 1
const nonce = randomUUID()
Reflect.set(globalThis, slot, nonce)

it('starts a fresh file realm with canonical host defaults', () => {
  expect(inherited).toBeUndefined()
  expect(inheritedModuleFileCount).toBe(0)
  expect(takeRealAgentHomeWriteViolations()).toEqual([])
  const environment = getAppEnvironment()
  const userData = environment.getPath('userData')
  expect(fs.existsSync(userData)).toBe(true)
  expect(environment.getVersion()).toBe('0.0.0-test')
  expect(process.env.ORCA_AGENT_SESSION_ID).toBeUndefined()
  expect(process.env.ORCA_STRUCTURED_SESSION).toBeUndefined()
  const store = getSecretStore()
  const sealed = store.encryptString('native-sentinel')
  expect(sealed.toString()).toBe('vitest-sealed:native-sentinel')
  expect(store.decryptString(sealed)).toBe('native-sentinel')
  expect(() => store.decryptString(Buffer.from('plaintext'))).toThrow('ciphertext')
  expect(process.execPath).toBe(process.env.ORCA_TEST_NODE_EXECUTABLE)
  expect(process.env.ORCA_TEST_NODE_VERSION).toBe('24.21.0')
  console.log('ORCA_NATIVE_SENTINEL ' + JSON.stringify({
    kind: 'fresh-file', file, pid: process.pid, nonce, userData,
    inheritedAbsent: inherited === undefined, inheritedModuleFileCount,
    moduleOwnerNonce: nativeFileRealmObservation.ownerNonce, execPath: process.execPath,
    bunVersion: process.versions.bun, argv: process.argv, execArgv: process.execArgv
  }))
})

it('reinstalls defaults before each case despite an owned override', () => {
  const environment = getAppEnvironment()
  expect(environment.getVersion()).toBe('0.0.0-test')
  expect(getSecretStore().encryptString('x').toString()).toBe('vitest-sealed:x')
  setAppEnvironment({ ...environment, getVersion: () => 'owned-override' })
  const store = getSecretStore()
  setSecretStore({ ...store, encryptString: () => Buffer.from('owned-override') })
  expect(getAppEnvironment().getVersion()).toBe('owned-override')
  expect(getSecretStore().encryptString('x').toString()).toBe('owned-override')
})
