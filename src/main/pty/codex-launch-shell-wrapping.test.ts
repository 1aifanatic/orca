import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shouldUseShellReadyStartupDelivery } from '../../shared/codex-startup-delivery'
import { selectShellStartupFeatures } from '../shell-startup-features'

// Why: the codex --no-daemon wrapper only reaches shells Orca wraps. Every Orca
// Codex launch is wrapped; a plain zsh or fish tab is too, for a typed codex.
// A plain bash tab is not: its --rcfile wrapper would drop login-shell mode.
const COMMAND = "codex 'fix the bug'"
const NO_DAEMON = 'set -- --no-daemon "$@"'
const FISH_NO_DAEMON = 'set argv --no-daemon $argv'
const CASES: [shell: string, launch: string, command: string | undefined, marker: string][] = [
  ['/bin/bash', 'a Codex launch', COMMAND, NO_DAEMON],
  ['/bin/zsh', 'a Codex launch', COMMAND, NO_DAEMON],
  ['/bin/zsh', 'a plain tab', undefined, NO_DAEMON],
  ['/usr/bin/fish', 'a Codex launch', COMMAND, FISH_NO_DAEMON],
  ['/usr/bin/fish', 'a plain tab', undefined, FISH_NO_DAEMON]
]

function launchFeatures(shellPath: string, command: string | undefined) {
  // Why an empty env: a system-default Codex home, with hooks off and history
  // isolation off, carries no overlay key or ORCA_HISTFILE.
  const waitsForShellReady =
    command !== undefined && shouldUseShellReadyStartupDelivery({ command, shellPath })
  return selectShellStartupFeatures({
    shellPath,
    env: {},
    hasStartupCommand: command !== undefined,
    waitsForShellReady,
    emitsStartupIdentity: waitsForShellReady
  })
}

function wrapperText(config: { args: string[] | null; env: Record<string, string> }): string {
  if (config.env.ZDOTDIR) {
    return readFileSync(join(config.env.ZDOTDIR, '.zshenv'), 'utf8')
  }
  const rcfile = config.args?.[config.args.indexOf('--rcfile') + 1]
  return rcfile && config.args?.includes('--rcfile')
    ? readFileSync(rcfile, 'utf8')
    : (config.args ?? []).join('\n')
}

describe.skipIf(process.platform === 'win32')('Orca Codex launch shells carry the wrapper', () => {
  let userData: string
  const original = process.env.ORCA_USER_DATA_PATH

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-codex-launch-wrap-'))
    process.env.ORCA_USER_DATA_PATH = userData
    vi.resetModules()
  })

  afterEach(() => {
    if (original === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = original
    }
    rmSync(userData, { recursive: true, force: true })
  })

  it.each(CASES)('daemon transport wraps %s for %s', async (shell, _case, command, marker) => {
    const { getShellLaunchConfig } = await import('../daemon/shell-ready')

    expect(wrapperText(getShellLaunchConfig(shell, launchFeatures(shell, command)))).toContain(
      marker
    )
  })

  it.each(CASES)('local transport wraps %s for %s', async (shell, _case, command, marker) => {
    const { getShellLaunchConfig } = await import('../providers/local-pty-shell-ready')

    expect(
      wrapperText(getShellLaunchConfig(shell, launchFeatures(shell, command), command))
    ).toContain(marker)
  })

  it.each([
    ['daemon', '../daemon/shell-ready'],
    ['local', '../providers/local-pty-shell-ready']
  ])('%s transport keeps a plain bash tab an unwrapped login shell', async (_transport, path) => {
    const { getShellLaunchConfig } = await import(path)

    expect(getShellLaunchConfig('/bin/bash', launchFeatures('/bin/bash', undefined))).toEqual({
      args: null,
      env: {},
      supportsReadyMarker: false
    })
  })
})
