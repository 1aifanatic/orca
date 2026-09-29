import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getFishCodexShellLaunchPreflight,
  getPosixCodexShellLaunchPreflight,
  getPowerShellCodexShellLaunchPreflight
} from './codex-shell-launch-preflight'
import { resolveFishBinary } from '../../shared/fish-binary-requirement'

const fishLookup = resolveFishBinary()
const pwshAvailable =
  spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status === 0

const HELP_WITH_FLAG = 'Usage: codex [OPTIONS] [PROMPT]\n      --no-daemon  Run in-process\n'
const HELP_WITHOUT_FLAG = 'Usage: codex [OPTIONS] [PROMPT]\n      --no-alt-screen\n'

// Why argv as whole words: the rule is a whole-argument denylist (plan §4).
const ADDED: string[][] = [
  [],
  ['fix the bug'],
  ['exec the plan'],
  ['-m', 'gpt-5', '--yolo', 'x'],
  ['resume'],
  ['resume', '--last'],
  ['--yolo', 'resume', '--last'],
  ['fork', '--last'],
  ['-a', 'never', 'resume'],
  ['-c', 'model=o3'],
  ['archive', 'S'],
  ['delete', 'S'],
  ['exec', 'x'],
  ['e', 'x'],
  ['-m', 'x', 'exec', 'x'],
  ['review'],
  ['login'],
  ['mcp', 'list']
]
const UNCHANGED: string[][] = [
  ['agents'],
  ['-m', 'x', 'agents'],
  ['-c', 'k=v', 'agents'],
  ['--image=a.png', 'agents'],
  ['agents', '--remote', 'X'],
  ['queue', '--thread', 'T', '--message', 'M'],
  ['-c', 'k=v', 'queue'],
  ['--no-daemon'],
  ['resume', '--no-daemon'],
  ['-m', 'x', '--no-daemon'],
  ['--remote', 'unix://'],
  ['--remote=ws://h:1'],
  ['resume', '--remote', 'X'],
  ['-m', 'agents'],
  ['--', 'agents'],
  ['--', '--remote']
]
const ALL = [...ADDED, ...UNCHANGED]

type Shell = 'bash' | 'zsh' | 'fish' | 'pwsh'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

/** Fake codex: `--help` prints the help file; any other call prints its argv. */
function makeSandbox(help: string): { bin: string; helpFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-no-daemon-'))
  roots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const helpFile = join(root, 'help.txt')
  writeFileSync(helpFile, help)
  writeExecutable(
    join(bin, 'codex'),
    `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = --help ]; then cat ${JSON.stringify(helpFile)}; exit 0; fi
out=ARGV
for a in "$@"; do out="$out|$a"; done
[ "\${FAKE_CODEX_READ_STDIN:-}" = 1 ] && out="$out|stdin=$(cat)"
printf '%s\\n' "$out"
exit "\${FAKE_CODEX_EXIT:-0}"
`
  )
  return { bin, helpFile }
}

function quote(shell: Shell, word: string): string {
  if (shell === 'pwsh') {
    return `'${word.replace(/'/g, "''")}'`
  }
  if (shell === 'fish') {
    return `'${word.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  }
  return `'${word.replace(/'/g, `'\\''`)}'`
}

function codexCall(shell: Shell, argv: string[]): string {
  return ['codex', ...argv.map((word) => quote(shell, word))].join(' ')
}

function run(
  shell: Shell,
  script: string,
  bin: string,
  env: Record<string, string> = {},
  preamble = ''
): { status: number | null; stdout: string; stderr: string } {
  const template =
    shell === 'fish'
      ? getFishCodexShellLaunchPreflight()
      : shell === 'pwsh'
        ? getPowerShellCodexShellLaunchPreflight()
        : getPosixCodexShellLaunchPreflight()
  // Why the guard: rows include `login`, which a real codex would run against the host's account.
  const guard =
    shell === 'pwsh'
      ? `if ((Get-Command codex -CommandType Application | Select-Object -First 1).Source -ne ${quote(shell, join(bin, 'codex'))}) { exit 97 }`
      : shell === 'fish'
        ? `test (command -s codex) = ${quote(shell, join(bin, 'codex'))}; or exit 97`
        : `[ "$(command -v codex)" = ${quote(shell, join(bin, 'codex'))} ] || exit 97`
  const body = `${guard}\n${preamble}\n${template}\n${script}`
  // Why a file for bash/zsh: it is read line by line like a startup file, so an alias it defines applies.
  const scriptFile = join(bin, '..', 'script.sh')
  writeFileSync(scriptFile, body)
  const [command, args] =
    shell === 'bash'
      ? ['/bin/bash', ['--noprofile', '--norc', scriptFile]]
      : shell === 'zsh'
        ? ['/bin/zsh', ['-f', scriptFile]]
        : shell === 'fish'
          ? [fishLookup.path, ['--no-config', '-c', body]]
          : ['pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', body]]
  const result = spawnSync(command as string, args as string[], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      CODEX_HOME: join(bin, '..', 'codex-home'),
      ...env
    }
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function expectedLine(argv: string[], added: boolean): string {
  return ['ARGV', ...(added ? ['--no-daemon'] : []), ...argv].join('|')
}

const shells: [Shell, boolean][] = [
  ['bash', existsSync('/bin/bash')],
  ['zsh', existsSync('/bin/zsh')],
  ['fish', fishLookup.available],
  ['pwsh', pwshAvailable]
]

describe.skipIf(process.platform === 'win32')('codex wrapper --no-daemon rule', () => {
  it('has pwsh when CI demanded it', () => {
    expect(process.env.ORCA_REQUIRE_PWSH !== '1' || pwshAvailable).toBe(true)
  })

  for (const [shell, available] of shells) {
    describe.skipIf(!available)(shell, () => {
      it('adds --no-daemon first unless an argument is denylisted', () => {
        const { bin } = makeSandbox(HELP_WITH_FLAG)
        const result = run(shell, ALL.map((argv) => codexCall(shell, argv)).join('\n'), bin)

        expect(result.stderr).toBe('')
        expect(result.stdout.trimEnd().split('\n')).toEqual([
          ...ADDED.map((argv) => expectedLine(argv, true)),
          ...UNCHANGED.map((argv) => expectedLine(argv, false))
        ])
      })

      it('adds nothing when --help does not list the flag (0.155 and older)', () => {
        const { bin } = makeSandbox(HELP_WITHOUT_FLAG)
        const result = run(shell, ALL.map((argv) => codexCall(shell, argv)).join('\n'), bin)

        expect(result.stdout.trimEnd().split('\n')).toEqual(
          ALL.map((argv) => expectedLine(argv, false))
        )
      })

      it('adds nothing with ORCA_CODEX_ISOLATE=0, read on every call', () => {
        const { bin } = makeSandbox(HELP_WITH_FLAG)
        const setIsolate = (value: string): string =>
          shell === 'pwsh'
            ? `$env:ORCA_CODEX_ISOLATE = '${value}'`
            : shell === 'fish'
              ? `set -gx ORCA_CODEX_ISOLATE ${value}`
              : `export ORCA_CODEX_ISOLATE=${value}`
        const result = run(
          shell,
          ['codex a', setIsolate('1'), 'codex b', setIsolate('0'), 'codex c'].join('\n'),
          bin,
          { ORCA_CODEX_ISOLATE: '0' }
        )

        expect(result.stdout.trimEnd().split('\n')).toEqual([
          'ARGV|a',
          'ARGV|--no-daemon|b',
          'ARGV|c'
        ])
      })

      it('re-probes --help when Codex changes version mid-shell', () => {
        const { bin, helpFile } = makeSandbox(HELP_WITH_FLAG)
        const swap = (help: string): string =>
          shell === 'pwsh'
            ? `Set-Content -NoNewline -LiteralPath ${quote(shell, helpFile)} -Value ${quote(shell, help)}`
            : `printf '%s' ${quote(shell, help)} > ${quote(shell, helpFile)}`
        const result = run(
          shell,
          ['codex a', swap(HELP_WITHOUT_FLAG), 'codex b', swap(HELP_WITH_FLAG), 'codex c'].join(
            '\n'
          ),
          bin
        )

        expect(result.stdout.trimEnd().split('\n')).toEqual([
          'ARGV|--no-daemon|a',
          'ARGV|b',
          'ARGV|--no-daemon|c'
        ])
      })

      it("keeps piped stdin for Codex and returns Codex's exit status", () => {
        const { bin } = makeSandbox(HELP_WITH_FLAG)
        const script =
          shell === 'pwsh'
            ? `'piped' | codex exec -\n"status=$LASTEXITCODE"`
            : shell === 'fish'
              ? `printf piped | codex exec -\necho status=$status`
              : `printf piped | codex exec -\necho status=$?`
        const result = run(shell, script, bin, { FAKE_CODEX_READ_STDIN: '1', FAKE_CODEX_EXIT: '3' })

        expect(result.stdout.trimEnd().split('\n')).toEqual([
          'ARGV|--no-daemon|exec|-|stdin=piped',
          'status=3'
        ])
      })
    })
  }

  for (const [shell, enableAliases] of [
    ['bash', 'shopt -s expand_aliases'],
    ['zsh', 'setopt aliases']
  ] as const) {
    it.skipIf(!existsSync(`/bin/${shell}`))(
      `applies a user alias named codex defined before the wrapper in ${shell}`,
      () => {
        const { bin } = makeSandbox(HELP_WITH_FLAG)
        // Why `if true`: the shell parses the whole compound first, so the alias is live while the wrapper parses.
        const result = run(
          shell,
          'fi\ncodex x',
          bin,
          {},
          `${enableAliases}\nalias codex='codex --alias-flag'\nif true; then`
        )

        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout.trim()).toBe('ARGV|--no-daemon|--alias-flag|x')
      }
    )
  }

  it.skipIf(!existsSync('/bin/zsh'))('creates no globals under warn_create_global', () => {
    const { bin } = makeSandbox(HELP_WITH_FLAG)
    const result = run('zsh', 'setopt warn_create_global no_unset\ncodex x', bin)

    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe('ARGV|--no-daemon|x')
  })

  it.skipIf(!pwshAvailable)(
    'runs under StrictMode and Stop with a failing, noisy hook prep that leaves $LASTEXITCODE alone',
    () => {
      const { bin } = makeSandbox(HELP_WITH_FLAG)
      writeExecutable(join(bin, 'orca-prep'), '#!/bin/sh\necho prep-noise >&2\nexit 7\n')
      const result = run(
        'pwsh',
        'codex x\n"status=$LASTEXITCODE"',
        bin,
        { ORCA_CODEX_LAUNCH_PREFLIGHT: join(bin, 'orca-prep') },
        [
          'Set-StrictMode -Version Latest',
          '$ErrorActionPreference = "Stop"',
          '$PSNativeCommandUseErrorActionPreference = $true'
        ].join('\n')
      )

      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trimEnd().split('\n')).toEqual(['ARGV|--no-daemon|x', 'status=0'])
    }
  )
})
