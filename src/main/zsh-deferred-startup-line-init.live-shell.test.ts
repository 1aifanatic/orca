import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prependOrcaCliDirToChildPath } from './cli/orca-cli-child-path'
import { POSIX_SHELL_STARTUP_COMMAND_ENV } from './pty/posix-shell-startup-command'
import { getZshShellReadyWrapperFile } from './providers/local-pty-shell-ready-wrapper-generation'
import { encodeShellStartupFeatures, selectShellStartupFeatures } from './shell-startup-features'
import { ZSH_WRAPPER_DIR_MARKER_FILE } from './shell-templates'
import { hasZsh, MARKERS, runZshPty, ZSH_PATH } from './zsh-startup-hook-pty-harness'

const itWithZsh = hasZsh ? it : it.skip
const USER_WIDGET = `orca_test_line_init() {
  ORCA_USER_WIDGET_CALLS=$((\${ORCA_USER_WIDGET_CALLS:-0}+1))
  ORCA_USER_WIDGET_NAME="$WIDGET"
  return 1
}
zle -N zle-line-init orca_test_line_init
`

describe('zsh deferred startup after prompt-hook replacement', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  itWithZsh.each(['history', 'startup'] as const)(
    'restores CLI precedence and preserves the user widget in a %s pane',
    async (intent) => {
      const home = mkdtempSync(join(tmpdir(), 'orca-deferred-line-init-'))
      roots.push(home)
      const cliBin = join(home, 'cli', 'bin')
      const ambientBin = join(home, 'ambient-bin')
      const wrapperDir = join(home, 'wrapper')
      for (const bin of [cliBin, ambientBin, wrapperDir]) {
        mkdirSync(bin, { recursive: true })
      }
      for (const bin of [cliBin, ambientBin]) {
        writeFileSync(join(bin, 'orca-dev'), '#!/bin/sh\nexit 0\n')
        chmodSync(join(bin, 'orca-dev'), 0o755)
      }
      writeFileSync(join(home, '.zshenv'), USER_WIDGET)
      writeFileSync(
        join(home, '.zshrc'),
        'export PATH="$HOME/ambient-bin:/usr/bin:/bin:$HOME/cli/bin"\nprecmd_functions=()\n'
      )
      writeFileSync(join(wrapperDir, '.zshenv'), getZshShellReadyWrapperFile())
      writeFileSync(join(wrapperDir, ZSH_WRAPPER_DIR_MARKER_FILE), '')
      const env: Record<string, string> = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: `${ambientBin}:/usr/bin:/bin`,
        ZDOTDIR: wrapperDir,
        ORCA_HISTFILE: join(home, 'scoped-history')
      }
      const launcher = prependOrcaCliDirToChildPath(env, { isPackaged: false, userDataPath: home })
      const features = selectShellStartupFeatures({
        shellPath: ZSH_PATH,
        env,
        hasStartupCommand: intent === 'startup',
        waitsForShellReady: intent === 'startup',
        emitsStartupIdentity: false
      })
      env.ORCA_SHELL_FEATURES = encodeShellStartupFeatures(features)
      if (intent === 'startup') {
        env[POSIX_SHELL_STARTUP_COMMAND_ENV] = 'ORCA_STARTUP_RUNS=$((${ORCA_STARTUP_RUNS:-0}+1))'
      }

      const result = await runZshPty({
        env,
        commands: [
          'ORCA_LOOKUP=$(command -v orca-dev)',
          'ORCA_INIT_REMAINS=$+functions[__orca_deferred_line_init]',
          'ORCA_SAVED_WIDGET_REMAINS=$+widgets[__orca_saved_line_init]',
          'ORCA_LINE_INIT=${widgets[zle-line-init]:-none}',
          'ORCA_PRECMD="${precmd_functions[*]}"'
        ],
        report: [
          'ORCA_LOOKUP',
          'ORCA_USER_WIDGET_CALLS',
          'ORCA_USER_WIDGET_NAME',
          'ORCA_INIT_REMAINS',
          'ORCA_SAVED_WIDGET_REMAINS',
          'ORCA_LINE_INIT',
          'ORCA_PRECMD',
          'ORCA_STARTUP_RUNS',
          'HISTFILE'
        ]
      })

      expect(result.values.ORCA_LOOKUP).toBe(launcher)
      expect(Number(result.values.ORCA_USER_WIDGET_CALLS)).toBeGreaterThan(0)
      expect(result.values.ORCA_USER_WIDGET_NAME).toBe('zle-line-init')
      expect(result.values.ORCA_INIT_REMAINS).toBe('0')
      expect(result.values.ORCA_SAVED_WIDGET_REMAINS).toBe('0')
      expect(result.values.HISTFILE).toBe(join(home, 'scoped-history'))
      if (intent === 'history') {
        expect(result.output).not.toContain('\x1b]133;')
        expect(result.values.ORCA_LINE_INIT).toBe('user:orca_test_line_init')
        expect(result.values.ORCA_PRECMD).not.toContain('orca')
        expect(result.values.ORCA_STARTUP_RUNS).toBe('UNSET')
      } else {
        expect(result.output).toContain(MARKERS.ready)
        expect(result.values.ORCA_LINE_INIT).toBe('user:__orca_prompt_mark')
        expect(result.values.ORCA_PRECMD).toBe('__orca_osc133_precmd')
        expect(result.values.ORCA_STARTUP_RUNS).toBe('1')
      }
    }
  )
})
