import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureOverlayRestoreWrappers } from '../relay/pty-shell-overlay-wrappers'
import { getDaemonBashShellReadyRcfileContent } from './daemon/daemon-bash-shell-ready-rcfile'
import { getDaemonZshWrapperSpec } from './daemon/daemon-zsh-shell-ready-wrapper-spec'
import { getBashShellReadyRcfileContent } from './providers/local-pty-shell-ready-bash-rcfile'
import { getLocalZshWrapperSpec } from './providers/local-pty-shell-ready-wrapper-fileset'
import { shellMarksStartupCommand } from './shell-startup-command-marks'
import { selectShellStartupFeatures } from './shell-startup-features'
import { getFishShellReadyInitCommand } from './shell-templates'
import { buildZshStartupHook } from './zsh-startup-wrapper-builder'

const COMMAND_START = /133;C/

function startupFeatures(shellPath: string) {
  return selectShellStartupFeatures({
    shellPath,
    env: {},
    hasStartupCommand: true,
    waitsForShellReady: true,
    emitsStartupIdentity: true
  })
}

function marks(shellPath: string, options: { zsh: 'local' | 'daemon'; promptHook?: boolean }) {
  return shellMarksStartupCommand({
    shellPath,
    wrapperFeatures: startupFeatures(shellPath),
    zshWrapper: options.zsh === 'local' ? getLocalZshWrapperSpec() : getDaemonZshWrapperSpec(),
    startupCommandRunByPromptHook: options.promptHook ?? false
  })
}

let relayRoot: string | null = null

afterEach(() => {
  if (relayRoot) {
    rmSync(relayRoot, { recursive: true, force: true })
    relayRoot = null
  }
})

// Each row pairs the capability with the wrapper bytes Orca actually writes, so a wrapper that
// gains or loses its command-start mark cannot leave the capability behind.
describe('which shell launches mark their startup command', () => {
  it('zsh under the local and daemon wrappers: marked, and both wrappers write 133;C', () => {
    expect(marks('/bin/zsh', { zsh: 'local' })).toBe(true)
    expect(buildZshStartupHook(getLocalZshWrapperSpec())).toMatch(COMMAND_START)
    expect(marks('/bin/zsh', { zsh: 'daemon' })).toBe(true)
    expect(buildZshStartupHook(getDaemonZshWrapperSpec())).toMatch(COMMAND_START)
  })

  it('zsh under the SSH relay wrapper: unmarked, and that wrapper writes no 133;C', () => {
    relayRoot = mkdtempSync(join(tmpdir(), 'orca-relay-marks-'))
    expect(ensureOverlayRestoreWrappers(relayRoot)).toBe(true)
    expect(readFileSync(join(relayRoot, 'zsh', '.zshenv'), 'utf8')).not.toMatch(COMMAND_START)
    expect(
      shellMarksStartupCommand({
        shellPath: 'zsh',
        wrapperFeatures: startupFeatures('zsh'),
        zshWrapper: { osc133CommandMarkers: false },
        startupCommandRunByPromptHook: false
      })
    ).toBe(false)
  })

  it('bash: marked when the startup command is typed at its prompt, not when a prompt hook runs it', () => {
    expect(getBashShellReadyRcfileContent()).toMatch(COMMAND_START)
    expect(getDaemonBashShellReadyRcfileContent()).toMatch(COMMAND_START)
    expect(marks('/bin/bash', { zsh: 'daemon' })).toBe(true)
    expect(marks('/bin/bash', { zsh: 'local' })).toBe(true)
    expect(marks('/bin/bash', { zsh: 'local', promptHook: true })).toBe(false)
  })

  it('fish: unmarked, and its init command writes no 133;C', () => {
    expect(getFishShellReadyInitCommand('\\033]777;orca-shell-ready\\007', true, true)).not.toMatch(
      COMMAND_START
    )
    expect(marks('/usr/local/bin/fish', { zsh: 'local' })).toBe(false)
    expect(marks('/usr/local/bin/fish', { zsh: 'daemon' })).toBe(false)
  })

  it('a shell Orca does not wrap, or a wrapper that could not be written: unmarked', () => {
    for (const shellPath of ['/bin/zsh', '/bin/bash', '/bin/sh', '/bin/ksh', 'dash']) {
      expect(
        shellMarksStartupCommand({
          shellPath,
          wrapperFeatures: null,
          zshWrapper: getDaemonZshWrapperSpec(),
          startupCommandRunByPromptHook: false
        })
      ).toBe(false)
    }
    expect(marks('/bin/ksh', { zsh: 'daemon' })).toBe(false)
  })

  it('Windows shells: unmarked, so Windows keeps the base startup delivery', () => {
    for (const shellPath of ['C:\\Windows\\System32\\cmd.exe', 'powershell.exe', 'pwsh.exe']) {
      expect(marks(shellPath, { zsh: 'daemon' })).toBe(false)
    }
  })
})
