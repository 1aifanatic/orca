import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureCodexTrustConfig,
  readCodexTrustConfigGeneration,
  restoreCodexTrustConfig
} from './codex-trust-config-rollback'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempConfigPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-rollback-'))
  roots.push(root)
  return join(root, 'config.toml')
}

describe('Codex trust config rollback', () => {
  it('treats a missing config as absent and tolerates it remaining absent', () => {
    const configPath = tempConfigPath()
    const snapshot = captureCodexTrustConfig(configPath)

    expect(snapshot).toEqual({ existed: false })
    expect(() => restoreCodexTrustConfig(configPath, snapshot, null)).not.toThrow()
  })

  it('removes a config created after an absent snapshot', () => {
    const configPath = tempConfigPath()
    const snapshot = captureCodexTrustConfig(configPath)
    writeFileSync(configPath, 'rpc mutation')

    restoreCodexTrustConfig(configPath, snapshot, Buffer.from('rpc mutation'))
    expect(() => readFileSync(configPath)).toThrowError(/ENOENT/)
  })

  // Why: ordinary Windows CI tokens cannot create file symlinks without Developer Mode.
  it.skipIf(process.platform === 'win32')(
    'removes an RPC-created dangling-symlink target without deleting the user link',
    () => {
      const configPath = tempConfigPath()
      const targetDir = join(configPath, '..', 'dotfiles')
      const targetPath = join(targetDir, 'codex-config.toml')
      mkdirSync(targetDir)
      symlinkSync(join('dotfiles', 'codex-config.toml'), configPath)
      const snapshot = captureCodexTrustConfig(configPath)
      writeFileSync(targetPath, 'rpc mutation')

      restoreCodexTrustConfig(configPath, snapshot, Buffer.from('rpc mutation'))

      expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
      expect(() => readFileSync(targetPath)).toThrowError(/ENOENT/)
    }
  )

  it('atomically recreates exact contents and mode after the file disappears', () => {
    const configPath = tempConfigPath()
    const original = Buffer.from('# comment\r\n[hooks]\r\n')
    writeFileSync(configPath, original)
    chmodSync(configPath, 0o640)
    const snapshot = captureCodexTrustConfig(configPath)
    rmSync(configPath)

    restoreCodexTrustConfig(configPath, snapshot, null)

    expect(readFileSync(configPath)).toEqual(original)
    if (process.platform !== 'win32') {
      expect(statSync(configPath).mode & 0o777).toBe(0o640)
    }
  })

  it.skipIf(process.platform === 'win32')(
    'restores a symlink target without replacing the config.toml symlink',
    () => {
      const configPath = tempConfigPath()
      const targetDir = join(configPath, '..', 'dotfiles')
      const targetPath = join(targetDir, 'codex-config.toml')
      mkdirSync(targetDir)
      writeFileSync(targetPath, '# original\n')
      symlinkSync(targetPath, configPath)
      const snapshot = captureCodexTrustConfig(configPath)
      rmSync(targetPath)

      restoreCodexTrustConfig(configPath, snapshot, null)

      expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
      expect(readFileSync(targetPath, 'utf8')).toBe('# original\n')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'restores the captured mode when the contents already match',
    () => {
      const configPath = tempConfigPath()
      writeFileSync(configPath, '[hooks]\n')
      chmodSync(configPath, 0o640)
      const snapshot = captureCodexTrustConfig(configPath)
      chmodSync(configPath, 0o600)

      restoreCodexTrustConfig(configPath, snapshot, Buffer.from('[hooks]\n'))

      expect(readFileSync(configPath, 'utf8')).toBe('[hooks]\n')
      expect(statSync(configPath).mode & 0o777).toBe(0o640)
    }
  )

  it('restores the snapshot while the file still holds the generation Orca left', () => {
    const configPath = tempConfigPath()
    writeFileSync(configPath, 'model = "user"\n')
    const snapshot = captureCodexTrustConfig(configPath)
    writeFileSync(configPath, 'model = "user"\n[hooks.state]\n')
    const written = readCodexTrustConfigGeneration(configPath, snapshot)

    restoreCodexTrustConfig(configPath, snapshot, written)

    expect(readFileSync(configPath, 'utf8')).toBe('model = "user"\n')
  })

  // Why: a trust session runs for seconds between Orca's write and its rollback;
  // a save that lands in that window is newer than both generations.
  it.each([
    ['an existing config', 'model = "user"\n'],
    ['a config Orca created', null]
  ])('keeps a write that landed after Orca wrote %s', (_case, original) => {
    const configPath = tempConfigPath()
    if (original !== null) {
      writeFileSync(configPath, original)
    }
    const snapshot = captureCodexTrustConfig(configPath)
    writeFileSync(configPath, '[hooks.state]\n')
    const written = readCodexTrustConfigGeneration(configPath, snapshot)
    writeFileSync(configPath, 'model = "saved meanwhile"\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    restoreCodexTrustConfig(configPath, snapshot, written)

    expect(readFileSync(configPath, 'utf8')).toBe('model = "saved meanwhile"\n')
    expect(warn).toHaveBeenCalledOnce()
  })
})
