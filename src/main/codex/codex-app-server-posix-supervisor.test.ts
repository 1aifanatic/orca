import { describe, expect, it } from 'vitest'
import type { CodexAppServerLaunch } from './codex-app-server-connection'
import {
  createProviderSpawnSpec,
  isSupervisedProviderNotFound,
  POSIX_PROVIDER_SUPERVISOR_SCRIPT,
  PROVIDER_SIGTERM_GRACE_MS,
  PROVIDER_STDIN_END_GRACE_MS,
  supervisedPosixLaunch
} from './codex-app-server-posix-supervisor'

const launch: CodexAppServerLaunch = {
  command: '/opt/codex',
  args: ['app-server', '--flag'],
  cwd: '/work/repo',
  env: { CODEX_HOME: '/tmp/codex' }
}

describe('structured provider supervision', () => {
  it('wraps POSIX launches in a detached supervisor and preserves the launch spec', () => {
    const childEnv = { PATH: '/bin', CODEX_HOME: '/tmp/codex' }
    const spec = supervisedPosixLaunch(launch, childEnv)

    expect(spec.command).toBe(process.execPath)
    expect(spec.args).toEqual(['-e', POSIX_PROVIDER_SUPERVISOR_SCRIPT])
    expect(spec.env.PATH).toBe('/bin')
    expect(
      JSON.parse(Buffer.from(spec.env.ORCA_PROVIDER_SUPERVISOR_SPEC!, 'base64').toString())
    ).toEqual(
      expect.objectContaining({
        command: '/opt/codex',
        args: ['app-server', '--flag'],
        cwd: '/work/repo',
        ownerPid: process.pid,
        lifetime: 'session',
        stdinEndGraceMs: PROVIDER_STDIN_END_GRACE_MS,
        sigtermGraceMs: PROVIDER_SIGTERM_GRACE_MS
      })
    )
    expect(
      JSON.parse(Buffer.from(spec.env.ORCA_PROVIDER_SUPERVISOR_SPEC!, 'base64').toString())
    ).not.toHaveProperty('env')
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain(
      'delete childEnv.ORCA_PROVIDER_SUPERVISOR_SPEC'
    )
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain('delete childEnv.ELECTRON_RUN_AS_NODE')
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain(
      "process.stdin.once('close', scheduleOwnerShutdown)"
    )
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).not.toContain('process.ppid === 1')
  })

  it('carries a one-shot lifetime through the spawn spec', () => {
    const spec = createProviderSpawnSpec(launch, { PATH: '/bin' }, 'darwin', {
      lifetime: 'one-shot'
    })

    expect(spec).toMatchObject({ program: process.execPath, detached: true, supervised: true })
    expect(
      JSON.parse(Buffer.from(spec.env.ORCA_PROVIDER_SUPERVISOR_SPEC!, 'base64').toString())
    ).toMatchObject({ command: '/opt/codex', args: ['app-server', '--flag'], lifetime: 'one-shot' })
  })

  it('reads only the supervisor own missing-binary exit as not found', () => {
    expect(isSupervisedProviderNotFound(127, 'spawn /opt/my tools/claude ENOENT\n')).toBe(true)
    expect(isSupervisedProviderNotFound(1, 'spawn claude ENOENT\n')).toBe(false)
    expect(isSupervisedProviderNotFound(127, 'sh: claude: command not found\n')).toBe(false)
    expect(isSupervisedProviderNotFound(127, 'warning\nspawn claude ENOENT\n')).toBe(false)
  })

  it('refuses a grace longer than recovery waits before SIGKILL', () => {
    const stdinEnd = (stdinEndGraceMs: number) => () =>
      supervisedPosixLaunch(launch, {}, { stdinEndGraceMs })
    const sigterm = (sigtermGraceMs: number) => () =>
      supervisedPosixLaunch(launch, {}, { sigtermGraceMs })

    expect(stdinEnd(PROVIDER_STDIN_END_GRACE_MS)).not.toThrow()
    expect(stdinEnd(PROVIDER_STDIN_END_GRACE_MS + 1)).toThrow(RangeError)
    expect(sigterm(PROVIDER_SIGTERM_GRACE_MS)).not.toThrow()
    expect(sigterm(PROVIDER_SIGTERM_GRACE_MS + 1)).toThrow(RangeError)
  })

  it('uses direct provider spawning on Windows because the job owns the tree', () => {
    expect(createProviderSpawnSpec(launch, { PATH: '/bin' }, 'win32')).toEqual({
      program: '/opt/codex',
      args: ['app-server', '--flag'],
      env: { PATH: '/bin' },
      cwd: '/work/repo',
      detached: false,
      supervised: false
    })
  })
})
