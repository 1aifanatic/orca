import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClaudeFolderTrustFile from './claude/claude-folder-trust-file'

const mocks = vi.hoisted(() => ({
  codex: vi.fn<(path: string) => Promise<void>>(async () => {}),
  cursor: vi.fn<(path: string) => void>(),
  copilot: vi.fn<(path: string) => void>(),
  antigravity: vi.fn<(path: string) => void>(),
  qoder: vi.fn<(path: string) => void>(),
  remote: vi.fn<(args: unknown) => Promise<void>>(async () => {}),
  claudeGrant: vi.fn<typeof ClaudeFolderTrustFile.grantClaudeWorkspaceTrust>()
}))

vi.mock('./agent-trust-presets', () => ({
  markCodexProjectTrusted: mocks.codex,
  markCursorWorkspaceTrusted: mocks.cursor,
  markCopilotFolderTrusted: mocks.copilot,
  markAntigravityWorkspaceTrusted: mocks.antigravity
}))
vi.mock('./qoder/workspace-trust', () => ({ markQoderWorkspaceTrusted: mocks.qoder }))
vi.mock('./remote-agent-trust-presets', () => ({ markRemoteAgentWorkspaceTrusted: mocks.remote }))
vi.mock('./claude/claude-folder-trust-file', async (importOriginal) => {
  const actual = await importOriginal<typeof ClaudeFolderTrustFile>()
  mocks.claudeGrant.mockImplementation(actual.grantClaudeWorkspaceTrust)
  return { ...actual, grantClaudeWorkspaceTrust: mocks.claudeGrant }
})

import { applyAgentWorkspaceTrust, type AgentTrustLaunchContext } from './agent-workspace-trust'
import {
  AGENT_TRUST_WRITE_DEADLINE_MS,
  SHORT_AGENT_TRUST_WRITE_DEADLINE_MS
} from './agent-trust-write-deadline'

const WORKSPACE = '/workspace/app'
const local: AgentTrustLaunchContext = {
  env: {},
  claudeAuth: null,
  wslDistro: null,
  connectionId: null
}

function pending(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('applyAgentWorkspaceTrust on this machine', () => {
  it.each([
    ['codex', mocks.codex],
    ['cursor', mocks.cursor],
    ['copilot', mocks.copilot],
    ['qoder', mocks.qoder],
    // Why: one of the old copied switches omitted Antigravity, so workers launched there asked.
    ['antigravity', mocks.antigravity]
  ] as const)('writes the %s preset for the workspace', async (preset, writer) => {
    await expect(applyAgentWorkspaceTrust(preset, WORKSPACE, local)).resolves.toEqual({})
    expect(writer).toHaveBeenCalledWith(WORKSPACE)
    expect(mocks.remote).not.toHaveBeenCalled()
  })

  it('contains a rejected or throwing write so the launch proceeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.codex.mockRejectedValueOnce(new Error('write failed'))
    mocks.cursor.mockImplementationOnce(() => {
      throw new Error('write failed')
    })
    await expect(applyAgentWorkspaceTrust('codex', WORKSPACE, local)).resolves.toEqual({})
    await expect(applyAgentWorkspaceTrust('cursor', WORKSPACE, local)).resolves.toEqual({})
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('gives only Codex the long deadline its shared config lane needs', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const codexWrite = pending()
    mocks.codex.mockReturnValueOnce(codexWrite.promise)
    let codexSettled = false
    const codex = applyAgentWorkspaceTrust('codex', WORKSPACE, local).then(() => {
      codexSettled = true
    })
    await vi.advanceTimersByTimeAsync(SHORT_AGENT_TRUST_WRITE_DEADLINE_MS + 1)
    expect(codexSettled).toBe(false)
    await vi.advanceTimersByTimeAsync(AGENT_TRUST_WRITE_DEADLINE_MS)
    await codex
    expect(codexSettled).toBe(true)
    codexWrite.release()
    warn.mockRestore()
  })

  it('gives SSH writes the long deadline a slow link needs', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const remoteWrite = pending()
    mocks.remote.mockReturnValueOnce(remoteWrite.promise)
    let settled = false
    const cursor = applyAgentWorkspaceTrust('cursor', WORKSPACE, {
      ...local,
      connectionId: 'ssh-1'
    }).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(SHORT_AGENT_TRUST_WRITE_DEADLINE_MS + 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(AGENT_TRUST_WRITE_DEADLINE_MS)
    await cursor
    expect(settled).toBe(true)
    expect(String(warn.mock.calls[0]?.[0])).toContain('did not settle')
    remoteWrite.release()
    warn.mockRestore()
  })

  // Why: a config dir that does not exist keeps a regression here from writing a real config.
  const noConfig = { ...local, env: { CLAUDE_CONFIG_DIR: join(tmpdir(), 'orca-no-claude-config') } }
  it.each([
    ['the home folder', homedir(), noConfig],
    [
      'the home the spawn env names',
      '/home/agent',
      { ...noConfig, env: { ...noConfig.env, HOME: '/home/agent' } }
    ],
    ['a filesystem root', '/', noConfig],
    ['a drive root', 'C:\\', noConfig],
    ['a filesystem root over SSH', '/', { ...noConfig, connectionId: 'ssh-1' }]
  ])('never pre-trusts %s for any preset', async (_label, workspacePath, context) => {
    for (const preset of [
      'claude',
      'codex',
      'cursor',
      'copilot',
      'qoder',
      'antigravity'
    ] as const) {
      await expect(applyAgentWorkspaceTrust(preset, workspacePath, context)).resolves.toEqual({})
    }
    for (const writer of [
      mocks.codex,
      mocks.cursor,
      mocks.copilot,
      mocks.qoder,
      mocks.antigravity,
      mocks.remote,
      mocks.claudeGrant
    ]) {
      expect(writer).not.toHaveBeenCalled()
    }
  })

  it('never pre-trusts a home reached through a symlink, since the writers store the realpath', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-agent-trust-home-')))
    try {
      const home = join(root, 'home')
      mkdirSync(home)
      symlinkSync(home, join(root, 'home-link'), 'junction')
      const cases = [
        [join(root, 'home-link'), home],
        [home, join(root, 'home-link')]
      ]
      for (const [workspacePath, homePath] of cases) {
        const context = { ...noConfig, env: { ...noConfig.env, HOME: homePath } }
        for (const preset of ['claude', 'codex', 'cursor', 'copilot', 'qoder'] as const) {
          await applyAgentWorkspaceTrust(preset, workspacePath, context)
        }
      }
      for (const writer of [
        mocks.codex,
        mocks.cursor,
        mocks.copilot,
        mocks.qoder,
        mocks.claudeGrant
      ]) {
        expect(writer).not.toHaveBeenCalled()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['a WSL distro', { ...local, wslDistro: 'Ubuntu' }, WORKSPACE],
    ['a WSL UNC workspace', local, '\\\\wsl.localhost\\Ubuntu\\home\\u\\wt']
  ])('never writes the Windows home for %s', async (_label, context, workspacePath) => {
    for (const preset of ['codex', 'cursor', 'copilot', 'qoder', 'antigravity'] as const) {
      await applyAgentWorkspaceTrust(preset, workspacePath, context)
    }
    for (const writer of [mocks.codex, mocks.cursor, mocks.copilot, mocks.qoder]) {
      expect(writer).not.toHaveBeenCalled()
    }
    expect(mocks.antigravity).not.toHaveBeenCalled()
  })
})

describe('applyAgentWorkspaceTrust for Claude', () => {
  let root: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-agent-trust-')))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('grants in the config file the final spawn env names', async () => {
    writeFileSync(join(root, '.claude.json'), '{}')
    await applyAgentWorkspaceTrust('claude', root, {
      ...local,
      env: { CLAUDE_CONFIG_DIR: root }
    })
    expect(JSON.parse(readFileSync(join(root, '.claude.json'), 'utf-8'))).toEqual({
      projects: { [root]: { hasTrustDialogAccepted: true } }
    })
  })

  it('gives a local Claude write a short budget, after which Claude asks', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const grant = pending()
    mocks.claudeGrant.mockReturnValueOnce(grant.promise.then(() => 'granted' as const))
    let settled = false
    const claude = applyAgentWorkspaceTrust('claude', root, {
      ...local,
      env: { CLAUDE_CONFIG_DIR: root }
    }).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(SHORT_AGENT_TRUST_WRITE_DEADLINE_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await claude
    expect(settled).toBe(true)
    expect(String(warn.mock.calls[0]?.[0])).toContain('did not settle')
    grant.release()
    warn.mockRestore()
  })

  it('hands an SSH launch to the relay instead of writing anything here', async () => {
    await expect(
      applyAgentWorkspaceTrust('claude', '/srv/wt', { ...local, connectionId: 'ssh-1' })
    ).resolves.toEqual({ claudeFolderTrust: { workspacePath: '/srv/wt' } })
    expect(mocks.remote).not.toHaveBeenCalled()
  })

  it('sends other presets over SSH to the remote writer', async () => {
    await applyAgentWorkspaceTrust('antigravity', '/srv/wt', { ...local, connectionId: 'ssh-1' })
    expect(mocks.remote).toHaveBeenCalledWith({
      preset: 'antigravity',
      connectionId: 'ssh-1',
      workspacePath: '/srv/wt'
    })
    expect(mocks.antigravity).not.toHaveBeenCalled()
  })
})
