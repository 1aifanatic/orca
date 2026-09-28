import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexAppServerLaunch } from './codex-app-server-connection'
import {
  createProviderSpawnSpec,
  POSIX_PROVIDER_SUPERVISOR_SCRIPT,
  supervisedPosixLaunch
} from './codex-app-server-posix-supervisor'

const launch: CodexAppServerLaunch = {
  command: '/opt/codex',
  args: ['app-server', '--flag'],
  cwd: '/work/repo',
  env: { CODEX_HOME: '/tmp/codex' }
}

afterEach(() => vi.unstubAllGlobals())

describe('structured provider supervision', () => {
  it('wraps POSIX launches in a detached supervisor and preserves the launch spec', () => {
    vi.stubGlobal('process', { ...process, versions: { ...process.versions, bun: undefined } })
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
        cwd: '/work/repo'
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
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain('process.ppid !== originalParent')
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain(
      "process.stdin.once('close', scheduleOwnerShutdown)"
    )
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain('detached: true')
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain("process.kill(-child.pid, 'SIGKILL')")
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain('providerGroupExists()')
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain('finishWithProviderOutcome(code, signal)')
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).not.toContain('process.ppid === 1')
  })

  it('uses direct provider spawning on Windows because the job owns the tree', () => {
    expect(createProviderSpawnSpec(launch, { PATH: '/bin' }, 'win32')).toEqual({
      program: '/opt/codex',
      args: ['app-server', '--flag'],
      env: { PATH: '/bin' },
      cwd: '/work/repo',
      detached: false
    })
  })
})

it('isolates a Bun-hosted supervisor without changing the provider command', () => {
  vi.stubGlobal('process', {
    ...process,
    platform: 'linux',
    versions: { ...process.versions, bun: '1.4.2' }
  })
  const spec = createProviderSpawnSpec(launch, { PATH: '/bin' }, 'linux')
  expect(spec.args).toEqual([
    '--no-env-file',
    '--config=/dev/null',
    '--no-install',
    '-e',
    POSIX_PROVIDER_SUPERVISOR_SCRIPT
  ])
  expect(spec.cwd).toBe(launch.cwd)
  expect(
    JSON.parse(Buffer.from(spec.env.ORCA_PROVIDER_SUPERVISOR_SPEC!, 'base64').toString()).command
  ).toBe(launch.command)
})
