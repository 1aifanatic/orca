import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runProcess: vi.fn(),
  runCodexAppServerSession: vi.fn(),
  resolveWindowsShortPath: vi.fn()
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

import {
  _internals,
  awaitCodexHookSessionFlags,
  clearCodexHookSessionFlags,
  handleCodexHookFlagRequest,
  refreshCodexHookSessionFlags
} from './codex-hook-session-trust'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  getManagedCommand,
  getManagedScriptPath
} from './codex-hook-definition'
import { buildCodexHookSessionFlag } from './codex-hook-session-flags'
import { getCodexHookFlagTablePath, readCodexHookFlagEntry } from './codex-hook-flag-table'

/** hooks/list for a definition-only flag (untrusted), or for the full flag (trusted). */
function listingFor(command: string, flag: string, hashPrefix = 'sha256:'): unknown {
  const approved = /state\s*=/.test(flag)
  return {
    data: [
      {
        hooks: CODEX_EVENTS.map((eventName) => {
          const label = CODEX_EVENT_LABEL[eventName]
          return {
            key: `/<session-flags>/config.toml:${label}:0:0`,
            command,
            currentHash: `${hashPrefix}${label}`,
            trustStatus: approved ? 'trusted' : 'untrusted',
            source: 'sessionFlags'
          }
        })
      }
    ]
  }
}

const versions = new Map<string, string | null>()

function answerVersion(version: string | null, codex = '/opt/codex/bin/codex'): void {
  versions.set(codex, version)
}

function answerSession(
  respond: (command: string, flag: string) => unknown = (command, flag) => listingFor(command, flag)
): void {
  mocks.runCodexAppServerSession.mockImplementation(async (invocation, body) =>
    body({ request: async () => respond(hookCommand(), invocation.args[1]) })
  )
}

function hookCommand(): string {
  return getManagedCommand(getManagedScriptPath())
}

function versionFile(version: string): string {
  return join(getCodexHookFlagTablePath(), `${version}.flag`)
}

describe('codex hook session trust', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-codex-hook-trust-table-'))
    vi.stubEnv('ORCA_USER_DATA_PATH', userData)
    _internals.resetForTesting()
    versions.clear()
    mocks.runProcess.mockReset()
    mocks.runCodexAppServerSession.mockReset()
    mocks.runProcess.mockImplementation(async ({ program, args }) => {
      if (args[0] === '--help') {
        return { code: 0, stdout: 'Usage: codex [--no-daemon]', stderr: '', signal: null }
      }
      const version = versions.get(program) ?? null
      return version === null
        ? { code: 1, stdout: '', stderr: 'boom', signal: null, timedOut: false }
        : { code: 0, stdout: `${version}\n`, stderr: '', signal: null, timedOut: false }
    })
    answerSession()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(userData, { recursive: true, force: true })
  })

  it('asks Codex in a throwaway home and publishes an entry for that version', async () => {
    answerVersion('codex-cli 0.159.2')
    const entry = await refreshCodexHookSessionFlags()

    expect(entry?.codexVersion).toBe('codex-cli 0.159.2')
    expect(entry?.noDaemon).toBe(true)
    expect(readCodexHookFlagEntry('codex-cli 0.159.2')).toEqual(entry)
    expect(readFileSync(versionFile('codex-cli 0.159.2'), 'utf-8')).toContain('sha256:stop')
    const invocation = mocks.runCodexAppServerSession.mock.calls[0][0]
    expect(invocation.env.CODEX_HOME).toContain('orca-codex-hook-trust-')
    expect(invocation.args[0]).toBe('-c')
  })

  it('verifies the complete flag with Codex before publishing it', async () => {
    answerVersion('codex-cli 0.159.2')
    await refreshCodexHookSessionFlags()

    const [definitionRun, verifyRun] = mocks.runCodexAppServerSession.mock.calls
    expect(definitionRun[0].args[1]).not.toContain('state=')
    expect(verifyRun[0].args[1]).toBe(readCodexHookFlagEntry('codex-cli 0.159.2')?.flag)
  })

  it('publishes nothing when Codex does not trust the complete flag', async () => {
    answerVersion('codex-cli 0.159.2')
    answerSession((command, flag) => {
      const listing = listingFor(command, flag)
      return flag.includes('state=') ? listingFor(command, flag.replace('state=', 'x=')) : listing
    })

    expect(await refreshCodexHookSessionFlags()).toBeNull()
    expect(existsSync(versionFile('codex-cli 0.159.2'))).toBe(false)
  })

  it('reuses the published entry for the same version without a Codex session', async () => {
    answerVersion('codex-cli 0.159.2')
    await refreshCodexHookSessionFlags()
    _internals.resetForTesting()

    const entry = await refreshCodexHookSessionFlags()

    expect(mocks.runCodexAppServerSession).toHaveBeenCalledTimes(2)
    expect(entry?.codexVersion).toBe('codex-cli 0.159.2')
  })

  it('re-derives an entry whose definition this build no longer writes', async () => {
    answerVersion('codex-cli 0.159.2')
    const stale = buildCodexHookSessionFlag(
      hookCommand().replace('codex-hook', 'old-hook'),
      Object.fromEntries(
        CODEX_EVENTS.map((eventName) => [
          CODEX_EVENT_LABEL[eventName],
          { key: `k:${CODEX_EVENT_LABEL[eventName]}:0:0`, trustedHash: 'sha256:old' }
        ])
      )
    )!
    await refreshCodexHookSessionFlags()
    writeFileSync(versionFile('codex-cli 0.159.2'), `${stale}\n`)
    mocks.runCodexAppServerSession.mockClear()

    const entry = await refreshCodexHookSessionFlags()

    expect(mocks.runCodexAppServerSession).toHaveBeenCalledTimes(2)
    expect(entry?.flag).not.toBe(stale)
    expect(entry?.flag).toContain('sha256:stop')
  })

  it('keeps one entry per version, so panes on either binary carry their own', async () => {
    answerVersion('codex-cli 0.159.2')
    await refreshCodexHookSessionFlags()
    answerVersion('codex-cli 0.160.0')
    answerSession((command, flag) => listingFor(command, flag, 'sha256:new-'))

    const entry = await refreshCodexHookSessionFlags()

    expect(entry?.flag).toContain('sha256:new-stop')
    expect(readCodexHookFlagEntry('codex-cli 0.159.2')?.flag).toContain('sha256:stop')
    expect(readCodexHookFlagEntry('codex-cli 0.160.0')?.flag).toContain('sha256:new-stop')
  })

  it('publishes nothing when Codex does not report every event', async () => {
    answerVersion('codex-cli 0.159.2')
    answerSession(() => ({ data: [] }))

    expect(await refreshCodexHookSessionFlags()).toBeNull()
    expect(existsSync(versionFile('codex-cli 0.159.2'))).toBe(false)
  })

  it('publishes nothing, and does not throw, when the Codex session fails', async () => {
    answerVersion('codex-cli 0.159.2')
    mocks.runCodexAppServerSession.mockRejectedValue(new Error('timed out'))

    expect(await refreshCodexHookSessionFlags()).toBeNull()
  })

  it('shares one lookup between concurrent refreshes of one binary', async () => {
    answerVersion('codex-cli 0.159.2')
    await Promise.all([refreshCodexHookSessionFlags(), refreshCodexHookSessionFlags()])

    expect(
      mocks.runProcess.mock.calls.filter(([options]) => options.args[0] === '--version')
    ).toHaveLength(1)
  })

  it('publishes nothing when the opt-out lands while a derivation is in flight', async () => {
    answerVersion('codex-cli 0.159.2')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.runCodexAppServerSession.mockImplementation(async (invocation, body) => {
      await gate
      return body({ request: async () => listingFor(hookCommand(), invocation.args[1]) })
    })

    const refresh = refreshCodexHookSessionFlags()
    await vi.waitFor(() => expect(mocks.runCodexAppServerSession).toHaveBeenCalled())
    clearCodexHookSessionFlags()
    release()

    expect(await refresh).toBeNull()
    expect(existsSync(versionFile('codex-cli 0.159.2'))).toBe(false)
  })

  it("derives for the binary a launch's request names, not only the one Orca resolves", async () => {
    answerVersion('codex-cli 0.150.1', '/Users/me/.local/share/mise/shims/codex')

    const entry = await handleCodexHookFlagRequest({
      codexVersion: 'codex-cli 0.150.1',
      codexPath: '/Users/me/.local/share/mise/shims/codex'
    })

    expect(entry?.codexVersion).toBe('codex-cli 0.150.1')
    expect(mocks.runCodexAppServerSession.mock.calls[0][0].command).toBe(
      '/Users/me/.local/share/mise/shims/codex'
    )
  })

  it('stops asking a binary that never yields a flag', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      answerVersion('codex-cli 0.159.2')
      mocks.runCodexAppServerSession.mockRejectedValue(new Error('timed out'))
      const request = { codexVersion: 'codex-cli 0.159.2', codexPath: null }

      await handleCodexHookFlagRequest(request)
      // Why: within the backoff a repeated miss costs no Codex session.
      expect(handleCodexHookFlagRequest(request)).toBeNull()
      for (let attempt = 2; attempt <= 3; attempt += 1) {
        vi.setSystemTime(Date.now() + 60 * 60_000)
        await handleCodexHookFlagRequest(request)
      }
      vi.setSystemTime(Date.now() + 24 * 60 * 60_000)

      expect(handleCodexHookFlagRequest(request)).toBeNull()
      expect(mocks.runCodexAppServerSession).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds how long a launch waits for a derivation in flight', async () => {
    answerVersion('codex-cli 0.159.2')
    mocks.runCodexAppServerSession.mockImplementation(() => new Promise(() => {}))
    void refreshCodexHookSessionFlags()

    const started = Date.now()
    await awaitCodexHookSessionFlags(50)

    expect(Date.now() - started).toBeLessThan(2_000)
  })

  describe('on Windows, under a profile path the quote-free flag cannot spell', () => {
    const hostPlatform = process.platform

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      vi.stubEnv('HOME', join(userData, 'John Smith'))
      vi.stubEnv('USERPROFILE', join(userData, 'John Smith'))
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
    })

    it("carries the script's 8.3 name, which the bare spelling accepts", async () => {
      mocks.resolveWindowsShortPath.mockResolvedValue(
        'C:\\Users\\JOHNSM~1\\.orca\\agent-hooks\\codex-hook.cmd'
      )
      const shortCommand = 'C:/Users/JOHNSM~1/.orca/agent-hooks/codex-hook.cmd'
      answerSession((_command, flag) => listingFor(shortCommand, flag))
      answerVersion('codex-cli 0.159.2')

      const entry = await refreshCodexHookSessionFlags()

      expect(entry?.flag).toContain(
        "command = 'C:/Users/JOHNSM~1/.orca/agent-hooks/codex-hook.cmd'"
      )
      expect(entry?.flag).not.toMatch(/["%]/)
    })

    it('carries no hook when the volume keeps no 8.3 names', async () => {
      mocks.resolveWindowsShortPath.mockResolvedValue(null)
      answerVersion('codex-cli 0.159.2')

      expect(await refreshCodexHookSessionFlags()).toBeNull()
      expect(mocks.runCodexAppServerSession).not.toHaveBeenCalled()
    })
  })
})
