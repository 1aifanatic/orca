import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveFishBinary } from '../../shared/fish-binary-requirement'
import {
  getFishCodexShellLaunchPreflight,
  getPosixCodexShellLaunchPreflight
} from './codex-shell-launch-preflight'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fish = resolveFishBinary()
const fishPath = fish.available
  ? isAbsolute(fish.path)
    ? fish.path
    : ((process.env.PATH ?? '')
        .split(delimiter)
        .map((dir) => join(dir, fish.path))
        .find((path) => existsSync(path)) ?? '/missing/fish')
  : '/missing/fish'
const shells = [
  {
    shell: '/bin/bash',
    args: ['--noprofile', '--norc'],
    wrapper: getPosixCodexShellLaunchPreflight(),
    available: existsSync('/bin/bash')
  },
  {
    shell: '/bin/zsh',
    args: ['-f'],
    wrapper: getPosixCodexShellLaunchPreflight(),
    available: existsSync('/bin/zsh')
  },
  {
    shell: fishPath,
    args: ['--no-config'],
    wrapper: getFishCodexShellLaunchPreflight(),
    available: fish.available
  }
]

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-owned-'))
  roots.push(root)
  const bin = join(root, 'bin')
  await mkdir(bin)
  const executable = join(bin, 'codex')
  const preflight = join(bin, 'orca-preflight')
  // A shared server retains its first launcher's environment; an owned launch does not.
  await writeFile(
    executable,
    `#!/bin/sh
if [ "$1" = --no-daemon ]; then
  printf '%s:%s:%s\\n' "$ORCA_PANE_KEY" "$ORCA_AGENT_LAUNCH_TOKEN" "$ORCA_TERMINAL_HANDLE"
else
  if [ ! -f "$TEST_SERVER_IDENTITY" ]; then
    printf '%s:%s:%s\\n' "$ORCA_PANE_KEY" "$ORCA_AGENT_LAUNCH_TOKEN" "$ORCA_TERMINAL_HANDLE" > "$TEST_SERVER_IDENTITY"
  fi
  /bin/cat "$TEST_SERVER_IDENTITY"
fi
printf '<%s>' "$@"
printf '\\n'
exit "\${TEST_EXIT_CODE:-0}"
`
  )
  await writeFile(
    preflight,
    `#!/bin/sh
[ -z "$TEST_PREFLIGHT_LOG" ] || printf '%s\\n' "$*" >> "$TEST_PREFLIGHT_LOG"
[ "$4" = --launch-executable ] || exit 0
[ "$5" = "$TEST_EXECUTABLE" ] || exit 11
[ -z "$TEST_PREP_NOISE" ] || printf '%s\\n' "$TEST_PREP_NOISE"
[ "$TEST_CAPABILITY" = yes ] || exit 0
printf '%s\\n' --no-daemon
`
  )
  await Promise.all([chmod(executable, 0o755), chmod(preflight, 0o755)])
  return { root, bin, executable, preflight }
}

for (const spec of shells) {
  describe.skipIf(!spec.available || process.platform === 'win32')(
    `owned Codex launch in ${spec.shell}`,
    () => {
      it('keeps two panes in the same folder on their own identity, even with a shared server already present', async () => {
        const fixture = await sandbox()
        const identity = join(fixture.root, 'server-identity')
        await writeFile(identity, 'outside:outside:outside\n')
        for (const pane of ['a', 'b']) {
          const result = await runProcess({
            program: spec.shell,
            args: [...spec.args, '-c', `${spec.wrapper}\ncodex 'same folder prompt'`],
            cwd: fixture.root,
            env: {
              ...process.env,
              PATH: fixture.bin,
              ORCA_CODEX_LAUNCH_PREFLIGHT: fixture.preflight,
              TEST_EXECUTABLE: fixture.executable,
              TEST_CAPABILITY: 'yes',
              TEST_SERVER_IDENTITY: identity,
              ORCA_PANE_KEY: pane,
              ORCA_AGENT_LAUNCH_TOKEN: `${pane}-token`,
              ORCA_TERMINAL_HANDLE: `${pane}-handle`
            },
            timeoutMs: 5_000
          })
          expect(result.code, result.stderr).toBe(0)
          expect(result.stdout).toBe(
            `${pane}:${pane}-token:${pane}-handle\n<--no-daemon><same folder prompt>\n`
          )
        }
      })

      it.each([
        { command: "codex 'hello world'", flagged: true, argv: '<--no-daemon><hello world>' },
        { command: 'codex exec hello', flagged: false, argv: '<exec><hello>' }
      ])(
        'prepares hooks in exactly one CLI call for $command, even when prep logs to stdout',
        async ({ command, flagged, argv }) => {
          const fixture = await sandbox()
          const log = join(fixture.root, 'preflight-calls')
          const result = await runProcess({
            program: spec.shell,
            args: [...spec.args, '-c', `${spec.wrapper}\n${command}`],
            cwd: fixture.root,
            env: {
              ...process.env,
              PATH: fixture.bin,
              ORCA_CODEX_LAUNCH_PREFLIGHT: fixture.preflight,
              TEST_EXECUTABLE: fixture.executable,
              TEST_CAPABILITY: 'yes',
              TEST_PREP_NOISE: '[codex-trust-grant] granted 1 managed hook entries',
              TEST_PREFLIGHT_LOG: log,
              TEST_SERVER_IDENTITY: join(fixture.root, 'identity')
            },
            timeoutMs: 5_000
          })
          expect(result.code, result.stderr).toBe(0)
          expect(result.stdout.trim().split('\n').at(-1)).toBe(argv)
          const calls = (await readFile(log, 'utf8')).trim().split('\n')
          expect(calls).toHaveLength(1)
          expect(calls[0].startsWith('agent hooks prepare-codex')).toBe(true)
          expect(calls[0].includes('--launch-executable')).toBe(flagged)
        }
      )

      it.each([
        { command: "codex 'hello world'", capability: 'unknown', argv: '<hello world>' },
        {
          command: "codex resume 'session id'",
          capability: 'yes',
          argv: '<--no-daemon><resume><session id>'
        },
        { command: 'codex fork session', capability: 'yes', argv: '<--no-daemon><fork><session>' },
        { command: 'codex exec hello', capability: 'yes', argv: '<exec><hello>' },
        { command: 'codex app-server', capability: 'yes', argv: '<app-server>' },
        { command: 'codex --version', capability: 'yes', argv: '<--version>' },
        { command: 'codex --no-daemon hello', capability: 'yes', argv: '<--no-daemon><hello>' },
        {
          command: "codex -m model 'hello world'",
          capability: 'yes',
          argv: '<--no-daemon><-m><model><hello world>'
        }
      ])(
        'preserves argv and exit status for $command with capability=$capability',
        async ({ command, capability, argv }) => {
          const fixture = await sandbox()
          const result = await runProcess({
            program: spec.shell,
            args: [...spec.args, '-c', `${spec.wrapper}\n${command}`],
            cwd: fixture.root,
            env: {
              ...process.env,
              PATH: fixture.bin,
              ORCA_CODEX_LAUNCH_PREFLIGHT: fixture.preflight,
              TEST_EXECUTABLE: fixture.executable,
              TEST_CAPABILITY: capability,
              TEST_SERVER_IDENTITY: join(fixture.root, 'identity'),
              TEST_EXIT_CODE: '23'
            },
            timeoutMs: 5_000
          })
          expect(result.code, result.stderr).toBe(23)
          expect(result.stdout.trim().split('\n').at(-1)).toBe(argv)
        }
      )
    }
  )
}
