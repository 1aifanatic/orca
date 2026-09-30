import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CODEX_EVENTS, CODEX_EVENT_LABEL } from './codex-hook-definition'

const mocks = vi.hoisted(() => ({
  runProcess: vi.fn(),
  runCodexAppServerSession: vi.fn(),
  resolveWindowsShortPath: vi.fn(),
  memoDir: ''
}))

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: mocks.runProcess }))
vi.mock('./codex-app-server-session', () => ({
  runCodexAppServerSession: mocks.runCodexAppServerSession
}))
vi.mock('../codex-cli/command', () => ({
  resolveCodexCommand: () => '/opt/codex/bin/codex',
  withCliRuntimeOnPath: (_path: string, env: NodeJS.ProcessEnv) => env
}))
vi.mock('../windows/windows-short-path', () => ({
  resolveWindowsShortPath: mocks.resolveWindowsShortPath
}))
vi.mock('./codex-home-paths', () => ({
  getOrcaManagedCodexHomePath: () => join(mocks.memoDir, 'codex-runtime-home')
}))

import {
  _internals,
  getCodexHookSessionFlags,
  getCodexHookSessionFlagsForSettings,
  refreshCodexHookSessionFlags
} from './codex-hook-session-trust'
import { getManagedCommand, getManagedScriptPath } from './codex-hook-definition'

function listingFor(command: string, hashPrefix = 'sha256:'): unknown {
  return {
    data: [
      {
        hooks: CODEX_EVENTS.map((eventName) => {
          const label = CODEX_EVENT_LABEL[eventName]
          return {
            key: `/<session-flags>/config.toml:${label}:0:0`,
            command,
            currentHash: `${hashPrefix}${label}`,
            trustStatus: 'untrusted',
            source: 'sessionFlags'
          }
        })
      }
    ]
  }
}

function answerVersion(version: string | null): void {
  mocks.runProcess.mockResolvedValue(
    version === null
      ? { code: 1, stdout: '', stderr: 'boom', signal: null, timedOut: false }
      : { code: 0, stdout: `${version}\n`, stderr: '', signal: null, timedOut: false }
  )
}

describe('codex hook session trust', () => {
  let command: string

  beforeEach(() => {
    mocks.memoDir = mkdtempSync(join(tmpdir(), 'orca-codex-hook-trust-memo-'))
    _internals.resetForTesting()
    mocks.runProcess.mockReset()
    mocks.runCodexAppServerSession.mockReset()
    command = getManagedCommand(getManagedScriptPath())
    mocks.runCodexAppServerSession.mockImplementation(async (_invocation, body) =>
      body({ request: async () => listingFor(command) })
    )
  })

  afterEach(() => {
    rmSync(mocks.memoDir, { recursive: true, force: true })
  })

  it('asks Codex in a throwaway home and publishes a flag for that version', async () => {
    answerVersion('codex-cli 0.159.2')
    const flags = await refreshCodexHookSessionFlags()

    expect(flags?.codexVersion).toBe('codex-cli 0.159.2')
    expect(flags?.flag).toContain('sha256:stop')
    expect(getCodexHookSessionFlags()).toEqual(flags)
    const invocation = mocks.runCodexAppServerSession.mock.calls[0][0]
    expect(invocation.env.CODEX_HOME).toContain('orca-codex-hook-trust-')
    expect(invocation.args[0]).toBe('-c')
  })

  it('reuses the saved answer for the same version without a Codex session', async () => {
    answerVersion('codex-cli 0.159.2')
    await refreshCodexHookSessionFlags()
    _internals.resetForTesting()

    const flags = await refreshCodexHookSessionFlags()

    expect(mocks.runCodexAppServerSession).toHaveBeenCalledTimes(1)
    expect(flags?.codexVersion).toBe('codex-cli 0.159.2')
  })

  it('asks again when Codex reports a new version', async () => {
    answerVersion('codex-cli 0.159.2')
    await refreshCodexHookSessionFlags()
    answerVersion('codex-cli 0.160.0')
    mocks.runCodexAppServerSession.mockImplementation(async (_invocation, body) =>
      body({ request: async () => listingFor(command, 'sha256:new-') })
    )

    const flags = await refreshCodexHookSessionFlags()

    expect(mocks.runCodexAppServerSession).toHaveBeenCalledTimes(2)
    expect(flags?.codexVersion).toBe('codex-cli 0.160.0')
    expect(flags?.flag).toContain('sha256:new-stop')
  })

  it('asks again when the saved answer is corrupt, instead of latching no flag', async () => {
    answerVersion('codex-cli 0.159.2')
    writeFileSync(
      join(mocks.memoDir, 'codex-hook-session-trust.json'),
      JSON.stringify({
        version: 1,
        platform: process.platform,
        codexVersion: 'codex-cli 0.159.2',
        command,
        trust: {}
      })
    )

    const flags = await refreshCodexHookSessionFlags()

    expect(mocks.runCodexAppServerSession).toHaveBeenCalledTimes(1)
    expect(flags).not.toBeNull()
    const memo = JSON.parse(
      readFileSync(join(mocks.memoDir, 'codex-hook-session-trust.json'), 'utf-8')
    )
    expect(Object.keys(memo.trust)).toHaveLength(CODEX_EVENTS.length)
  })

  it('publishes no flag when Codex does not report every event', async () => {
    answerVersion('codex-cli 0.159.2')
    mocks.runCodexAppServerSession.mockImplementation(async (_invocation, body) =>
      body({ request: async () => ({ data: [] }) })
    )

    expect(await refreshCodexHookSessionFlags()).toBeNull()
    expect(getCodexHookSessionFlags()).toBeNull()
  })

  it('clears the published flag when codex stops answering --version', async () => {
    answerVersion('codex-cli 0.159.2')
    await refreshCodexHookSessionFlags()
    answerVersion(null)

    expect(await refreshCodexHookSessionFlags()).toBeNull()
    expect(getCodexHookSessionFlags()).toBeNull()
  })

  it('publishes no flag, and does not throw, when the Codex session fails', async () => {
    answerVersion('codex-cli 0.159.2')
    mocks.runCodexAppServerSession.mockRejectedValue(new Error('timed out'))

    expect(await refreshCodexHookSessionFlags()).toBeNull()
  })

  it('shares one lookup between concurrent refreshes', async () => {
    answerVersion('codex-cli 0.159.2')
    await Promise.all([refreshCodexHookSessionFlags(), refreshCodexHookSessionFlags()])

    expect(mocks.runProcess).toHaveBeenCalledTimes(1)
  })

  it('hands no flag to a launch while Codex hooks are off', async () => {
    answerVersion('codex-cli 0.159.2')
    await refreshCodexHookSessionFlags()

    expect(getCodexHookSessionFlagsForSettings({ agentStatusHooksEnabled: false })).toBeNull()
    expect(getCodexHookSessionFlagsForSettings({ disabledTuiAgents: ['codex'] })).toBeNull()
    expect(getCodexHookSessionFlagsForSettings({})).not.toBeNull()
  })

  describe('on Windows, under a profile path the quote-free flag cannot spell', () => {
    const hostPlatform = process.platform

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      vi.stubEnv('HOME', join(mocks.memoDir, 'John Smith'))
      vi.stubEnv('USERPROFILE', join(mocks.memoDir, 'John Smith'))
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
      vi.unstubAllEnvs()
    })

    it("carries the script's 8.3 name, which the bare spelling accepts", async () => {
      mocks.resolveWindowsShortPath.mockResolvedValue(
        'C:\\Users\\JOHNSM~1\\.orca\\agent-hooks\\codex-hook.cmd'
      )
      command = 'C:/Users/JOHNSM~1/.orca/agent-hooks/codex-hook.cmd'
      answerVersion('codex-cli 0.159.2')

      const flags = await refreshCodexHookSessionFlags()

      expect(flags?.flag).toContain(
        "command = 'C:/Users/JOHNSM~1/.orca/agent-hooks/codex-hook.cmd'"
      )
      expect(flags?.flag).not.toMatch(/["%]/)
    })

    it('carries no hook when the volume keeps no 8.3 names', async () => {
      mocks.resolveWindowsShortPath.mockResolvedValue(null)
      answerVersion('codex-cli 0.159.2')

      expect(await refreshCodexHookSessionFlags()).toBeNull()
      expect(mocks.runCodexAppServerSession).not.toHaveBeenCalled()
    })
  })
})
