import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getFishCodexShellLaunchPreflight,
  getPosixCodexShellLaunchPreflight,
  getPowerShellCodexShellLaunchPreflight
} from '../../shared/codex-shell-function'
import { resolveFishBinary } from '../../shared/fish-binary-requirement'

// Why: the codex function carries Orca's status hook as `-c <flag>` only when its
// own binary reports the version the flag's approval was derived for, and the
// Codex home holds no Orca file entry. A carried flag with a foreign hash would
// open Codex's hook-review screen, so every other case must carry nothing.

const isWindows = process.platform === 'win32'
const fishLookup = resolveFishBinary()
const pwshAvailable =
  spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status === 0
const FLAG = "hooks={ Stop = [{ hooks = [{ type = 'command', command = 'x' }] }] }"
const VERSION = 'codex-cli 9.9.9'

type Shell = 'bash' | 'zsh' | 'fish' | 'pwsh'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

type Sandbox = { root: string; bin: string; codexHome: string }

/** Fake codex: `--version` prints FAKE_CODEX_VERSION, `--help` lists no --no-daemon, else prints argv. */
function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-hook-flag-'))
  roots.push(root)
  const bin = join(root, 'bin')
  const codexHome = join(root, 'codex-home')
  mkdirSync(bin)
  mkdirSync(codexHome)
  if (isWindows) {
    writeFileSync(
      join(bin, 'fake.js'),
      `const a = process.argv.slice(2)
if (a[0] === '--version') { console.log(process.env.FAKE_CODEX_VERSION || ''); process.exit(0) }
if (a[0] === '--help') { console.log('Usage: codex'); process.exit(0) }
console.log(['ARGV', ...a].join('|'))
`
    )
    writeFileSync(join(bin, 'codex.cmd'), '@node "%~dp0fake.js" %*\r\n')
    return { root, bin, codexHome }
  }
  const codex = join(bin, 'codex')
  writeFileSync(
    codex,
    `#!/bin/sh
if [ "$1" = --version ]; then printf '%s\\n' "\${FAKE_CODEX_VERSION:-}"; exit 0; fi
if [ "$1" = --help ]; then echo 'Usage: codex'; exit 0; fi
out=ARGV
for a in "$@"; do out="$out|$a"; done
printf '%s\\n' "$out"
`
  )
  chmodSync(codex, 0o755)
  return { root, bin, codexHome }
}

function run(shell: Shell, sandbox: Sandbox, env: Record<string, string>): string {
  const template =
    shell === 'fish'
      ? getFishCodexShellLaunchPreflight()
      : shell === 'pwsh'
        ? getPowerShellCodexShellLaunchPreflight()
        : getPosixCodexShellLaunchPreflight()
  const body = `${template}\ncodex resume --last`
  const scriptFile = join(sandbox.root, 'script')
  writeFileSync(scriptFile, body)
  const [command, args]: [string, string[]] =
    shell === 'bash'
      ? ['/bin/bash', ['--noprofile', '--norc', scriptFile]]
      : shell === 'zsh'
        ? ['/bin/zsh', ['-f', scriptFile]]
        : shell === 'fish'
          ? [String(fishLookup.path), ['--no-config', '-c', body]]
          : ['pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', body]]
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${sandbox.bin}${delimiter}${process.env.PATH ?? ''}`,
      CODEX_HOME: sandbox.codexHome,
      ORCA_CODEX_ISOLATE: '0',
      ORCA_CODEX_HOOK_CONFIG: '',
      ORCA_CODEX_HOOK_VERSION: '',
      FAKE_CODEX_VERSION: '',
      ...env
    }
  })
  expect(result.stderr).toBe('')
  return result.stdout.trimEnd()
}

const WITH_FLAG = `ARGV|-c|${FLAG}|resume|--last`
const WITHOUT_FLAG = 'ARGV|resume|--last'

const shells: [Shell, boolean][] = [
  ['bash', !isWindows && existsSync('/bin/bash')],
  ['zsh', !isWindows && existsSync('/bin/zsh')],
  ['fish', fishLookup.available],
  ['pwsh', pwshAvailable]
]

describe('codex function status hook flag', () => {
  for (const [shell, available] of shells) {
    describe.skipIf(!available)(shell, () => {
      it('carries the flag when its binary reports the derived version', () => {
        const sandbox = makeSandbox()
        const out = run(shell, sandbox, {
          ORCA_CODEX_HOOK_CONFIG: FLAG,
          ORCA_CODEX_HOOK_VERSION: VERSION,
          FAKE_CODEX_VERSION: VERSION
        })
        expect(out).toBe(WITH_FLAG)
      })

      it('never carries the flag to a binary of another version, whose hash could differ', () => {
        const sandbox = makeSandbox()
        const out = run(shell, sandbox, {
          ORCA_CODEX_HOOK_CONFIG: FLAG,
          ORCA_CODEX_HOOK_VERSION: VERSION,
          FAKE_CODEX_VERSION: 'codex-cli 9.9.10'
        })
        expect(out).toBe(WITHOUT_FLAG)
      })

      it('carries nothing into a home an older Orca entry still posts status from', () => {
        const sandbox = makeSandbox()
        writeFileSync(
          join(sandbox.codexHome, 'hooks.json'),
          JSON.stringify({
            hooks: { Stop: [{ hooks: [{ command: '/x/.orca/agent-hooks/codex-hook.sh' }] }] }
          })
        )
        const out = run(shell, sandbox, {
          ORCA_CODEX_HOOK_CONFIG: FLAG,
          ORCA_CODEX_HOOK_VERSION: VERSION,
          FAKE_CODEX_VERSION: VERSION
        })
        expect(out).toBe(WITHOUT_FLAG)
      })

      it('carries nothing when the pane has no flag', () => {
        const sandbox = makeSandbox()
        // Why matching versions: only the missing flag may explain the plain launch.
        const out = run(shell, sandbox, {
          ORCA_CODEX_HOOK_VERSION: VERSION,
          FAKE_CODEX_VERSION: VERSION
        })
        expect(out).toBe(WITHOUT_FLAG)
      })
    })
  }
})
