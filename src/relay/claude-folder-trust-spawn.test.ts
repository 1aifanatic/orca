import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyRelayClaudeFolderTrust } from './claude-folder-trust-spawn'
import { buildSshPtySpawnRequest } from '../main/providers/ssh-pty-spawn-request'

const HOST_SHELL = { wslShell: false }

let root: string
let configDir: string
let workspace: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-relay-claude-trust-')))
  configDir = join(root, 'cfg')
  mkdirSync(configDir)
  writeFileSync(join(configDir, '.claude.json'), '{"oauthAccount":{"x":1}}', { mode: 0o600 })
  workspace = join(root, 'wt')
  mkdirSync(workspace)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('applyRelayClaudeFolderTrust', () => {
  it("grants in the remote host's own config, named by the merged spawn env", async () => {
    await applyRelayClaudeFolderTrust(
      { workspacePath: workspace },
      { CLAUDE_CONFIG_DIR: configDir, HOME: root },
      HOST_SHELL
    )
    expect(JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf-8'))).toEqual({
      oauthAccount: { x: 1 },
      projects: { [workspace]: { hasTrustDialogAccepted: true } }
    })
  })

  it('falls back to HOME/.claude.json when the spawn env names no config dir', async () => {
    writeFileSync(join(root, '.claude.json'), '{}')
    await applyRelayClaudeFolderTrust({ workspacePath: workspace }, { HOME: root }, HOST_SHELL)
    expect(JSON.parse(readFileSync(join(root, '.claude.json'), 'utf-8'))).toEqual({
      projects: { [workspace]: { hasTrustDialogAccepted: true } }
    })
  })

  it("never writes this host's config for a Claude started in a WSL guest", async () => {
    await applyRelayClaudeFolderTrust(
      { workspacePath: workspace },
      { CLAUDE_CONFIG_DIR: configDir, HOME: root },
      { wslShell: true }
    )
    expect(readFileSync(join(configDir, '.claude.json'), 'utf-8')).toBe('{"oauthAccount":{"x":1}}')
  })

  it("never pre-trusts the relay host's home folder", async () => {
    writeFileSync(join(root, '.claude.json'), '{}')
    await applyRelayClaudeFolderTrust({ workspacePath: root }, { HOME: root }, HOST_SHELL)
    expect(readFileSync(join(root, '.claude.json'), 'utf-8')).toBe('{}')
  })

  it('never creates a config file Claude has not written', async () => {
    const emptyHome = join(root, 'empty-home')
    mkdirSync(emptyHome)
    await applyRelayClaudeFolderTrust({ workspacePath: workspace }, { HOME: emptyHome }, HOST_SHELL)
    expect(existsSync(join(emptyHome, '.claude.json'))).toBe(false)
  })

  it('ignores a spawn with no, a malformed, or an earlier-shaped request', async () => {
    const env = { CLAUDE_CONFIG_DIR: configDir, HOME: root }
    await applyRelayClaudeFolderTrust(undefined, env, HOST_SHELL)
    await applyRelayClaudeFolderTrust({ workspacePath: 42 }, env, HOST_SHELL)
    await applyRelayClaudeFolderTrust({ worktreeRoot: workspace, trusted: true }, env, HOST_SHELL)
    expect(readFileSync(join(configDir, '.claude.json'), 'utf-8')).toBe('{"oauthAccount":{"x":1}}')
  })
})

describe('buildSshPtySpawnRequest', () => {
  it('forwards the workspace to trust as an optional field an old relay ignores', () => {
    const request = buildSshPtySpawnRequest({
      options: { cols: 80, rows: 24, claudeFolderTrust: { workspacePath: '/w' } },
      supportsCreateOperation: false
    })
    expect(request.claudeFolderTrust).toEqual({ workspacePath: '/w' })
    expect(
      buildSshPtySpawnRequest({ options: { cols: 80, rows: 24 }, supportsCreateOperation: false })
    ).not.toHaveProperty('claudeFolderTrust')
  })
})
