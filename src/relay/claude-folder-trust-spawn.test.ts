import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyRelayClaudeFolderTrust } from './claude-folder-trust-spawn'
import { buildSshPtySpawnRequest } from '../main/providers/ssh-pty-spawn-request'

let root: string
let configDir: string
let worktree: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-relay-claude-trust-')))
  configDir = join(root, 'cfg')
  mkdirSync(configDir)
  writeFileSync(join(configDir, '.claude.json'), '{"oauthAccount":{"x":1}}', { mode: 0o600 })
  const repo = join(root, 'repo')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i'],
    { cwd: repo }
  )
  worktree = join(root, 'wt')
  execFileSync('git', ['worktree', 'add', '-q', worktree], { cwd: repo })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('applyRelayClaudeFolderTrust', () => {
  it("writes the remote host's own config, named by the merged spawn env", async () => {
    await applyRelayClaudeFolderTrust(
      { worktreeRoot: worktree, mainCheckoutPath: join(root, 'repo'), trusted: true },
      { CLAUDE_CONFIG_DIR: configDir, HOME: root }
    )
    expect(JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf-8'))).toEqual({
      oauthAccount: { x: 1 },
      projects: { [worktree]: { hasTrustDialogAccepted: true } }
    })
  })

  it('ignores a spawn with no or a malformed request', async () => {
    await applyRelayClaudeFolderTrust(undefined, { CLAUDE_CONFIG_DIR: configDir, HOME: root })
    await applyRelayClaudeFolderTrust(
      { worktreeRoot: 42, trusted: true },
      { CLAUDE_CONFIG_DIR: configDir, HOME: root }
    )
    expect(readFileSync(join(configDir, '.claude.json'), 'utf-8')).toBe('{"oauthAccount":{"x":1}}')
  })
})

describe('buildSshPtySpawnRequest', () => {
  it('forwards the desired trust state as an optional field', () => {
    const request = buildSshPtySpawnRequest({
      options: {
        cols: 80,
        rows: 24,
        claudeFolderTrust: { worktreeRoot: '/w', mainCheckoutPath: '/r', trusted: true }
      },
      supportsCreateOperation: false
    })
    expect(request.claudeFolderTrust).toEqual({
      worktreeRoot: '/w',
      mainCheckoutPath: '/r',
      trusted: true
    })
    expect(
      buildSshPtySpawnRequest({ options: { cols: 80, rows: 24 }, supportsCreateOperation: false })
    ).not.toHaveProperty('claudeFolderTrust')
  })
})
