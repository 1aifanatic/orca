import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeClaudeProfile,
  prepareClaudeProfileDirectory,
  readClaudeProfileObject
} from './claude-profile-paths'

const roots: string[] = []
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-profile-paths-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Claude profile namespace', () => {
  it('binds the new namespace to an account and execution target without touching legacy auth', () => {
    const dir = root()
    const target = { executionHostId: 'remote-a', runtime: 'wsl', distro: 'Ubuntu' } as const
    const profile = describeClaudeProfile(dir, 'account-a', target)
    expect(profile).toEqual({
      version: 1,
      accountId: 'account-a',
      target,
      home: join(dir, 'claude-profiles/account-a/home')
    })
    prepareClaudeProfileDirectory(dir, profile)
    expect(() =>
      prepareClaudeProfileDirectory(dir, {
        ...profile,
        home: join(dir, 'claude-accounts/account-a/auth')
      })
    ).toThrow()
    expect(() => describeClaudeProfile(dir, '../escape', target)).toThrow()
  })
  it('rejects a linked account parent before creating a profile outside the namespace', () => {
    const dir = root()
    mkdirSync(join(dir, 'claude-profiles'))
    const outside = root()
    symlinkSync(outside, join(dir, 'claude-profiles/a'), 'junction')
    expect(() =>
      prepareClaudeProfileDirectory(
        dir,
        describeClaudeProfile(dir, 'a', { runtime: 'host', executionHostId: 'local' })
      )
    ).toThrow('link')
  })
  it('distinguishes missing from empty, malformed, nonobject and inaccessible JSON', () => {
    const file = join(root(), 'state.json')
    expect(readClaudeProfileObject(file).kind).toBe('absent')
    for (const value of ['', '{', '[]', 'null']) {
      writeFileSync(file, value)
      expect(readClaudeProfileObject(file).kind).toBe('unavailable')
    }
    expect(readClaudeProfileObject(join(file, 'child')).kind).toBe('unavailable')
    writeFileSync(file, '{"theme":"dark"}')
    expect(readClaudeProfileObject(file)).toEqual({ kind: 'present', value: { theme: 'dark' } })
  })
})
