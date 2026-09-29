import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyClaudeFolderTrust,
  convergeClaudeFolderTrust,
  resolveClaudeGlobalConfigFile,
  toClaudeTrustKey
} from './claude-folder-trust-file'
import { convergeClaudeWorktreeTrustOnHost } from './claude-worktree-trust-host'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-claude-trust-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeConfig(file: string, value: unknown, mode = 0o600): void {
  writeFileSync(file, JSON.stringify(value), { mode })
  chmodSync(file, mode)
}

function readConfig(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf-8'))
}

describe('toClaudeTrustKey', () => {
  it('NFC-normalises so a decomposed path matches the key Claude looks up', () => {
    const decomposed = '/tmp/cafe\u0301'
    expect(toClaudeTrustKey(decomposed, 'posix')).toBe('/tmp/caf\u00e9')
  })

  it('uses forward slashes on Windows, as Claude does', () => {
    expect(toClaudeTrustKey('C:\\Users\\me\\wt\\', 'win32')).toBe('C:/Users/me/wt/')
    expect(toClaudeTrustKey('C:\\Users\\me\\.\\wt', 'win32')).toBe('C:/Users/me/wt')
  })
})

describe('resolveClaudeGlobalConfigFile', () => {
  const none = (): boolean => false

  it('defaults to ~/.claude.json, never ~/.claude/.claude.json', () => {
    expect(
      resolveClaudeGlobalConfigFile({ env: {}, homeDir: '/home/u', style: 'posix', exists: none })
    ).toBe('/home/u/.claude.json')
  })

  it('uses CLAUDE_CONFIG_DIR/.claude.json when set', () => {
    expect(
      resolveClaudeGlobalConfigFile({
        env: { CLAUDE_CONFIG_DIR: '/cfg' },
        homeDir: '/home/u',
        style: 'posix',
        exists: none
      })
    ).toBe('/cfg/.claude.json')
  })

  it('prefers the legacy .config.json in the config dir', () => {
    expect(
      resolveClaudeGlobalConfigFile({
        env: {},
        homeDir: '/home/u',
        style: 'posix',
        exists: (p) => p === '/home/u/.claude/.config.json'
      })
    ).toBe('/home/u/.claude/.config.json')
  })

  it('follows the custom-OAuth file suffix', () => {
    expect(
      resolveClaudeGlobalConfigFile({
        env: { CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://x' },
        homeDir: '/home/u',
        style: 'posix',
        exists: none
      })
    ).toBe('/home/u/.claude-custom-oauth.json')
  })
})

describe('applyClaudeFolderTrust', () => {
  const grant = { folderKeys: ['/wt'], inheritedTrustKeys: ['/repo'], trusted: true }

  it('is a no-op when the canonical repo root is already trusted', () => {
    expect(
      applyClaudeFolderTrust({ projects: { '/repo': { hasTrustDialogAccepted: true } } }, grant)
    ).toEqual({ kind: 'unchanged' })
  })

  it('refuses a non-object projects map instead of replacing it', () => {
    expect(applyClaudeFolderTrust({ projects: [] }, grant)).toEqual({ kind: 'refuse' })
  })

  it('revokes only the exact entry shape Orca writes', () => {
    const claudeOwned = { allowedTools: [], hasTrustDialogAccepted: true }
    const change = applyClaudeFolderTrust(
      {
        projects: {
          '/wt': { hasTrustDialogAccepted: true },
          '/other': claudeOwned
        }
      },
      { folderKeys: ['/wt', '/other'], inheritedTrustKeys: [], trusted: false }
    )
    expect(change).toEqual({ kind: 'changed', config: { projects: { '/other': claudeOwned } } })
  })
})

describe('convergeClaudeFolderTrust', () => {
  it('merges the key and keeps every other field', async () => {
    const file = join(root, '.claude.json')
    writeConfig(file, {
      oauthAccount: { emailAddress: 'x' },
      mcpServers: { a: {} },
      projects: { '/elsewhere': { hasTrustDialogAccepted: true, allowedTools: [] } }
    })
    await expect(
      convergeClaudeFolderTrust({
        configFile: file,
        folderKeys: ['/wt'],
        inheritedTrustKeys: [],
        trusted: true
      })
    ).resolves.toBe('granted')
    expect(readConfig(file)).toEqual({
      oauthAccount: { emailAddress: 'x' },
      mcpServers: { a: {} },
      projects: {
        '/elsewhere': { hasTrustDialogAccepted: true, allowedTools: [] },
        '/wt': { hasTrustDialogAccepted: true }
      }
    })
  })

  it('keeps an owner-only mode through the rewrite', async () => {
    const file = join(root, '.claude.json')
    writeConfig(file, {}, 0o600)
    await convergeClaudeFolderTrust({
      configFile: file,
      folderKeys: ['/wt'],
      inheritedTrustKeys: [],
      trusted: true
    })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('never creates a missing config file', async () => {
    const file = join(root, '.claude.json')
    await expect(
      convergeClaudeFolderTrust({
        configFile: file,
        folderKeys: ['/wt'],
        inheritedTrustKeys: [],
        trusted: true
      })
    ).resolves.toBe('missing-config')
    expect(existsSync(file)).toBe(false)
  })

  it('leaves a corrupt file byte-for-byte untouched', async () => {
    const file = join(root, '.claude.json')
    writeFileSync(file, '{"oauthAccount": ', { mode: 0o600 })
    await expect(
      convergeClaudeFolderTrust({
        configFile: file,
        folderKeys: ['/wt'],
        inheritedTrustKeys: [],
        trusted: true
      })
    ).resolves.toBe('unreadable')
    expect(readFileSync(file, 'utf-8')).toBe('{"oauthAccount": ')
  })

  it('does nothing while Claude holds its lock, and leaves the lock in place', async () => {
    const file = join(root, '.claude.json')
    writeConfig(file, {})
    const lockDir = `${file}.lock`
    mkdirSync(lockDir)
    const oldTime = new Date(Date.now() - 60_000)
    // Why: a lock older than Claude's 10 s stale window must still not be broken by Orca.
    utimesSync(lockDir, oldTime, oldTime)
    await expect(
      convergeClaudeFolderTrust({
        configFile: file,
        folderKeys: ['/wt'],
        inheritedTrustKeys: [],
        trusted: true
      })
    ).resolves.toBe('locked')
    expect(readConfig(file)).toEqual({})
    expect(existsSync(lockDir)).toBe(true)
  })

  it('updates a symlinked config through its target and keeps the link', async () => {
    const target = join(root, 'dotfiles-claude.json')
    const link = join(root, '.claude.json')
    writeConfig(target, { theme: 'dark' })
    symlinkSync(target, link)
    await convergeClaudeFolderTrust({
      configFile: link,
      folderKeys: ['/wt'],
      inheritedTrustKeys: [],
      trusted: true
    })
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readConfig(target)).toEqual({
      theme: 'dark',
      projects: { '/wt': { hasTrustDialogAccepted: true } }
    })
  })

  it('leaves the parent directory mode alone', async () => {
    const home = join(root, 'home')
    mkdirSync(home, { mode: 0o755 })
    chmodSync(home, 0o755)
    const file = join(home, '.claude.json')
    writeConfig(file, {})
    await convergeClaudeFolderTrust({
      configFile: file,
      folderKeys: ['/wt'],
      inheritedTrustKeys: [],
      trusted: true
    })
    expect(statSync(home).mode & 0o777).toBe(0o755)
  })
})

describe('convergeClaudeWorktreeTrustOnHost', () => {
  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'ignore' })
  }

  function makeRepoWithWorktree(): { repo: string; worktree: string } {
    const repo = join(root, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    git(
      repo,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'i'
    )
    const worktree = join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', worktree)
    return { repo, worktree }
  }

  it('trusts the linked worktree root and never the main checkout', async () => {
    const { repo, worktree } = makeRepoWithWorktree()
    const file = join(root, '.claude.json')
    writeConfig(file, {})
    await expect(
      convergeClaudeWorktreeTrustOnHost({
        configFile: file,
        worktreeRoot: worktree,
        mainCheckoutPath: repo,
        trusted: true,
        keyStyle: 'posix'
      })
    ).resolves.toBe('granted')
    expect(readConfig(file)).toEqual({ projects: { [worktree]: { hasTrustDialogAccepted: true } } })
  })

  it('refuses a main checkout even when asked', async () => {
    const { repo } = makeRepoWithWorktree()
    const file = join(root, '.claude.json')
    writeConfig(file, {})
    await expect(
      convergeClaudeWorktreeTrustOnHost({
        configFile: file,
        worktreeRoot: repo,
        mainCheckoutPath: repo,
        trusted: true,
        keyStyle: 'posix'
      })
    ).resolves.toBe('not-linked-worktree')
    expect(readConfig(file)).toEqual({})
  })

  it('revokes the key after the worktree folder is gone', async () => {
    const file = join(root, '.claude.json')
    const gone = join(root, 'removed-wt')
    writeConfig(file, { projects: { [gone]: { hasTrustDialogAccepted: true } } })
    await expect(
      convergeClaudeWorktreeTrustOnHost({
        configFile: file,
        worktreeRoot: gone,
        mainCheckoutPath: null,
        trusted: false,
        keyStyle: 'posix'
      })
    ).resolves.toBe('revoked')
    expect(readConfig(file)).toEqual({ projects: {} })
  })
})
