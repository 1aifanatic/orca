import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restoreManagedDataAccountEnvironment } from '../../shared/managed-data-account-environment'
import { openCodeAcpAccountBinding } from '../opencode/opencode-structured-account-home'
import { resolveHostStructuredAgentCreateSupport } from './structured-agent-launch-support'

// Live QA run 5 on #25845: the app launched with HOME and every XDG directory pointed into the rig,
// and OpenCode's Command and per-agent PATH both naming a private 1.18.31. The host's whole create
// check, with a real `--version` against stand-in scripts, must admit that OpenCode.

const { loginShell } = vi.hoisted(() => ({ loginShell: { env: {} as Record<string, string> } }))
vi.mock('../startup/login-shell-environment', () => ({
  resolveLoginShellEnvironment: async () => loginShell.env
}))

let root: string
let privateOpencode: string

/** A stand-in `opencode` that answers `--version` with `version`; never a real agent CLI. */
async function fakeOpencode(dir: string, version: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'opencode')
  await writeFile(file, `#!/bin/sh\necho ${version}\n`)
  await chmod(file, 0o755)
  return file
}

function rigSettings(command: string) {
  return {
    nativeChatInheritShellEnvironment: true,
    nativeChatShellEnvironmentVariables: [],
    agentCmdOverrides: { opencode: command },
    agentDefaultEnv: { opencode: { PATH: `${join(root, 'oc-prefix', 'bin')}:/usr/bin:/bin` } }
  }
}

/** `agentSession.createSupport` on this host for a local git worktree under the rig's settings. */
function createSupport(settings: ReturnType<typeof rigSettings>) {
  return resolveHostStructuredAgentCreateSupport({
    agent: 'opencode',
    worktreeSelector: 'id:workspace-1',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    runtime: {
      requireStore: () => ({ getSettings: () => settings }),
      resolveRuntimeFileTarget: async () => ({ worktree: { path: join(root, 'proj') } })
    },
    getSettings: () => ({ claudeManagedAccounts: [], activeClaudeManagedAccountId: null })
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-opencode-rig-'))
  await mkdir(join(root, 'proj'))
  const homebrew = await fakeOpencode(join(root, 'homebrew'), '2.0.21')
  privateOpencode = await fakeOpencode(join(root, 'oc-prefix', 'bin'), '1.18.31')
  const home = join(root, 'home-r7')
  loginShell.env = {
    PATH: `${join(homebrew, '..')}:/usr/bin:/bin`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache')
  }
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('OpenCode create support under the QA rig', () => {
  it('admits the private 1.18.31 the Command setting names, with every XDG directory set', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    expect(await createSupport(rigSettings(privateOpencode))).toEqual({ supported: true })
    expect(info).toHaveBeenCalledWith(
      `[agent-cli-version] ${privateOpencode} --version: 1.18.31 is supported`
    )
  })

  it('names the check that refused a 2.x Command in the main log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const homebrew = join(root, 'homebrew', 'opencode')

    expect(await createSupport(rigSettings(homebrew))).toEqual({
      supported: false,
      reason: 'agent'
    })
    expect(warn).toHaveBeenCalledWith(
      '[structured-create-support] opencode unsupported: installed-agent check refused (reason agent)'
    )
  })

  it('pins the rig XDG directories as the account rather than refusing it', async () => {
    const managedAccounts = {
      list: () => ({ accounts: [], activeAccountId: null }),
      restoreOriginalEnvironment: restoreManagedDataAccountEnvironment,
      environmentForAccount: () => ({})
    }
    const binding = openCodeAcpAccountBinding(() => managedAccounts)

    await expect(
      binding.resolve({
        launchEnv: rigSettings(privateOpencode).agentDefaultEnv.opencode,
        baseEnvironment: async () => loginShell.env
      })
    ).resolves.toEqual({
      kind: 'opencode',
      locator: {
        kind: 'unmanaged',
        dataHome: loginShell.env.XDG_DATA_HOME,
        stateHome: loginShell.env.XDG_STATE_HOME,
        databaseSelection: { kind: 'default' }
      }
    })
  })
})
