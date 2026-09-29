import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPtyShellLaunchPlan } from '../daemon/pty-subprocess/shell-launch-plan'
import { createDaemonPtyEnvironment } from '../daemon/pty-subprocess/spawn-environment'
import { finalizeLocalPtySpawnEnvironment } from './local-pty-finalize-environment'
import { createLocalPtyLaunchPlan } from './local-pty-launch-plan'

// Why: a plain tab launched with the user's configured shell args stays exactly
// their shell; Orca wraps it only when it needs a feature (e.g. zsh history).
const CONFIGURED_ARGS = ['--custom-arg']
const SHELLS = ['/bin/bash', '/bin/zsh', '/usr/bin/fish']

describe.skipIf(process.platform === 'win32')('plain tabs with configured shell args', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-configured-shell-args-'))
    vi.stubEnv('ORCA_USER_DATA_PATH', userData)
    // Why: the daemon env inherits this process's; a parent's zsh or history setting must not leak in.
    vi.stubEnv('ZDOTDIR', undefined)
    vi.stubEnv('ORCA_HISTFILE', undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(userData, { recursive: true, force: true })
  })

  it.each(SHELLS)('daemon transport keeps %s unwrapped on the configured args', (shell) => {
    const opts = {
      sessionId: 'configured-args',
      cols: 80,
      rows: 24,
      cwd: userData,
      shellOverride: shell,
      terminalShellArgs: CONFIGURED_ARGS
    }
    const env = createDaemonPtyEnvironment(opts)

    const plan = createPtyShellLaunchPlan(opts, env)

    expect(plan.shellArgs).toEqual(CONFIGURED_ARGS)
    expect(env.ZDOTDIR).toBeUndefined()
    expect(env.ORCA_SHELL_FEATURES).toBeUndefined()
  })

  it.each(SHELLS)('local transport keeps %s unwrapped on the configured args', (shell) => {
    const spawn = {
      cols: 80,
      rows: 24,
      cwd: userData,
      shellOverride: shell,
      terminalShellArgs: CONFIGURED_ARGS
    }
    const getOptions = () => ({})
    const plan = createLocalPtyLaunchPlan(spawn, getOptions)
    if (!('shellArgs' in plan)) {
      throw new Error('expected a resolved posix launch plan')
    }
    const env: Record<string, string> = { HOME: userData }

    finalizeLocalPtySpawnEnvironment({ spawn, getOptions, plan, env })

    expect(plan.shellArgs).toEqual(CONFIGURED_ARGS)
    expect(env.ZDOTDIR).toBeUndefined()
    expect(env.ORCA_SHELL_FEATURES).toBeUndefined()
  })
})
