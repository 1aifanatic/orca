import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  forgetCodexHookTrust,
  getCodexHookTrustMemoPath,
  fingerprintCodex,
  memoizeCodexHookTrust,
  readMemoizedCodexHookTrust,
  readMemoizedVersionHashes
} from './codex-hook-trust-memo'

let userData: string
let codexPath: string
const COMMAND = '/home/u/.orca/agent-hooks/codex-hook.sh'
const HASHES = { stop: 'sha256:stop', session_start: 'sha256:start' }

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'orca-codex-trust-memo-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', userData)
  codexPath = join(userData, 'codex')
  writeFileSync(codexPath, 'codex 0.150.1')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(userData, { recursive: true, force: true })
})

function remember(path = codexPath, codexVersion = 'codex-cli 0.150.1'): void {
  memoizeCodexHookTrust(path, fingerprintCodex(path), COMMAND, {
    codexVersion,
    hashes: HASHES,
    failure: null
  })
}

describe('Codex hook trust memo', () => {
  it('answers for the same binary bytes and hook command, and only those', () => {
    remember()

    expect(readMemoizedCodexHookTrust(codexPath, COMMAND)).toEqual({
      codexVersion: 'codex-cli 0.150.1',
      hashes: HASHES,
      failure: null
    })
    expect(readMemoizedCodexHookTrust(codexPath, '/other/codex-hook.sh')).toBeNull()

    writeFileSync(codexPath, 'codex 0.160.0, replaced by an update')
    expect(readMemoizedCodexHookTrust(codexPath, COMMAND)).toBeNull()
    // Why: the version's hashes outlive the binary, so a reinstall of that version asks no hooks/list.
    expect(readMemoizedVersionHashes('codex-cli 0.150.1', COMMAND)?.hashes).toEqual(HASHES)
  })

  it('remembers a failure for the binary until it changes or is forgotten', () => {
    memoizeCodexHookTrust(codexPath, fingerprintCodex(codexPath), COMMAND, {
      codexVersion: 'codex-cli 0.128.0',
      hashes: null,
      failure: 'does not report hook approvals'
    })

    expect(readMemoizedCodexHookTrust(codexPath, COMMAND)?.failure).toBe(
      'does not report hook approvals'
    )
    forgetCodexHookTrust(codexPath)
    expect(readMemoizedCodexHookTrust(codexPath, COMMAND)).toBeNull()
  })

  it('reads an unreadable or foreign file as empty, and keeps a bounded record', () => {
    writeFileSync(getCodexHookTrustMemoPath(), '{ not json')
    expect(readMemoizedCodexHookTrust(codexPath, COMMAND)).toBeNull()

    for (let index = 0; index < 12; index += 1) {
      const path = join(userData, `codex-${index}`)
      writeFileSync(path, `codex ${index}`)
      remember(path, `codex-cli 0.${index}.0`)
    }

    const memo = JSON.parse(readFileSync(getCodexHookTrustMemoPath(), 'utf-8'))
    expect(Object.keys(memo.binaries)).toHaveLength(8)
    expect(Object.keys(memo.versions)).toHaveLength(8)
    expect(readMemoizedVersionHashes('codex-cli 0.11.0', COMMAND)).not.toBeNull()
    expect(readMemoizedVersionHashes('codex-cli 0.0.0', COMMAND)).toBeNull()
  })

  it('drops hashes that are not Codex hash strings', () => {
    writeFileSync(
      getCodexHookTrustMemoPath(),
      JSON.stringify({
        binaries: {},
        versions: { 'codex-cli 0.150.1': { command: COMMAND, hashes: { stop: 42, bogus: 'x' } } }
      })
    )

    expect(readMemoizedVersionHashes('codex-cli 0.150.1', COMMAND)).toBeNull()
  })
})
