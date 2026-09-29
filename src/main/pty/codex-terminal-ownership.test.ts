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
  // Like a version-manager shim, a .codex-version file in the cwd selects the version.
  // Like clap, a build older than 0.156 refuses --no-daemon before it reaches --version.
  await writeFile(
    executable,
    `#!/bin/sh
version=\${TEST_CODEX_VERSION-}
[ ! -f .codex-version ] || version=$(/bin/cat .codex-version)
if [ "$1" = --no-daemon ]; then
  case "\${TEST_NO_DAEMON:-$version}" in
    accept|0.15[6-9].*|0.1[6-9][0-9].*|[1-9]*) ;;
    *) printf "error: unexpected argument '--no-daemon' found\\n" >&2; exit 2 ;;
  esac
fi
for arg in "$@"; do
  if [ "$arg" = --version ]; then
    [ -z "$TEST_PROBE_LOG" ] || printf '%s\\n' "$version" >> "$TEST_PROBE_LOG"
    if [ -n "\${TEST_VERSION_OUTPUT+set}" ]; then printf '%b' "$TEST_VERSION_OUTPUT"; else printf 'codex-cli %s\\n' "$version"; fi
    exit "\${TEST_VERSION_EXIT:-0}"
  fi
done
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
printf '%s\\n' "$*" >> "$TEST_PREFLIGHT_LOG"
`
  )
  await Promise.all([chmod(executable, 0o755), chmod(preflight, 0o755)])
  return { root, bin, executable, preflight, log: join(root, 'preflight-calls') }
}

type Fixture = Awaited<ReturnType<typeof sandbox>>

function launch(
  spec: (typeof shells)[number],
  fixture: Fixture,
  command: string,
  env: Record<string, string | undefined>,
  cwd = fixture.root
) {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    // Why: this suite may itself run inside an Orca pane.
    ORCA_CODEX_HOME: undefined,
    PATH: fixture.bin,
    ORCA_CODEX_LAUNCH_PREFLIGHT: fixture.preflight,
    TEST_PREFLIGHT_LOG: fixture.log,
    TEST_SERVER_IDENTITY: join(fixture.root, 'identity'),
    ...env
  }
  return runProcess({
    program: spec.shell,
    args: [...spec.args, '-c', `${spec.wrapper}\n${command}`],
    cwd,
    env: Object.fromEntries(
      Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined)
    ),
    timeoutMs: 5_000
  })
}

async function readLines(path: string): Promise<string[]> {
  return existsSync(path) ? (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean) : []
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
          const result = await launch(spec, fixture, "codex 'same folder prompt'", {
            TEST_CODEX_VERSION: '0.158.0',
            TEST_SERVER_IDENTITY: identity,
            ORCA_PANE_KEY: pane,
            ORCA_AGENT_LAUNCH_TOKEN: `${pane}-token`,
            ORCA_TERMINAL_HANDLE: `${pane}-handle`
          })
          expect(result.code, result.stderr).toBe(0)
          expect(result.stdout).toBe(
            `${pane}:${pane}-token:${pane}-handle\n<--no-daemon><same folder prompt>\n`
          )
        }
      })

      it.each([
        { command: "codex 'hello world'", argv: '<--no-daemon><hello world>', probes: 1 },
        { command: 'codex exec hello', argv: '<exec><hello>', probes: 0 }
      ])(
        'starts the Orca CLI only for a managed home, and probes only interactive launches: $command',
        async ({ command, argv, probes }) => {
          for (const managedHome of [undefined, '/managed/home']) {
            const fixture = await sandbox()
            const probeLog = join(fixture.root, 'probes')
            const result = await launch(spec, fixture, command, {
              TEST_CODEX_VERSION: '0.158.0',
              TEST_PROBE_LOG: probeLog,
              ORCA_CODEX_HOME: managedHome
            })
            expect(result.code, result.stderr).toBe(0)
            expect(result.stdout.trim().split('\n').at(-1)).toBe(argv)
            expect(await readLines(fixture.log)).toEqual(
              managedHome ? ['agent hooks prepare-codex'] : []
            )
            expect(await readLines(probeLog)).toHaveLength(probes)
          }
        }
      )

      it.each([
        { version: '0.156.0', flagged: true },
        { version: '0.156.0-alpha.1', flagged: true },
        { version: '0.158.0', flagged: true },
        { version: '1.0.0', flagged: true },
        { version: '0.155.1', flagged: false },
        { version: '0.155.0-alpha.9', flagged: false },
        { version: '', flagged: false }
      ])(
        'adds the flag only when that Codex accepts it: $version',
        async ({ version, flagged }) => {
          const fixture = await sandbox()
          const result = await launch(spec, fixture, "codex 'hello world'", {
            TEST_CODEX_VERSION: version
          })
          expect(result.code, result.stderr).toBe(0)
          expect(result.stdout.trim().split('\n').at(-1)).toBe(
            flagged ? '<--no-daemon><hello world>' : '<hello world>'
          )
        }
      )

      it.each([
        {
          name: 'a source build reporting 0.0.0',
          noDaemon: 'accept',
          version: '0.0.0',
          flagged: true
        },
        {
          name: 'unparseable version text',
          noDaemon: 'accept',
          output: 'mise 2026.9.1\\n',
          flagged: true
        },
        {
          name: 'a later build that drops the flag',
          noDaemon: 'reject',
          version: '9.0.0',
          flagged: false
        }
      ])(
        'decides from the probe exit status, not the version text: $name',
        async ({ noDaemon, version, output, flagged }) => {
          const fixture = await sandbox()
          const result = await launch(spec, fixture, "codex 'hello world'", {
            TEST_CODEX_VERSION: version ?? '0.158.0',
            TEST_NO_DAEMON: noDaemon,
            TEST_VERSION_OUTPUT: output
          })
          expect(result.code, result.stderr).toBe(0)
          expect(result.stdout.trim().split('\n').at(-1)).toBe(
            flagged ? '<--no-daemon><hello world>' : '<hello world>'
          )
        }
      )

      it('keeps a failed version probe on the unchanged launch', async () => {
        const fixture = await sandbox()
        const result = await launch(spec, fixture, "codex 'hello world'", {
          TEST_CODEX_VERSION: '0.158.0',
          TEST_VERSION_EXIT: '1'
        })
        expect(result.code, result.stderr).toBe(0)
        expect(result.stdout.trim().split('\n').at(-1)).toBe('<hello world>')
      })

      it.skipIf(spec.shell !== '/bin/zsh')(
        'prints nothing extra under zsh warn_create_global and nounset',
        async () => {
          const fixture = await sandbox()
          const result = await launch(
            spec,
            fixture,
            "setopt warn_create_global nounset\ncodex 'hello world'",
            { TEST_CODEX_VERSION: '0.158.0' }
          )
          expect(result.code, result.stderr).toBe(0)
          expect(result.stderr).toBe('')
          expect(result.stdout.trim().split('\n').at(-1)).toBe('<--no-daemon><hello world>')
        }
      )

      it('decides from the Codex a cwd-selected shim runs now, never an earlier answer', async () => {
        const fixture = await sandbox()
        const [current, old] = [join(fixture.root, 'current'), join(fixture.root, 'old')]
        await Promise.all([mkdir(current), mkdir(old)])
        await writeFile(join(current, '.codex-version'), '0.158.0\n')
        await writeFile(join(old, '.codex-version'), '0.155.0\n')
        const result = await launch(
          spec,
          fixture,
          ["codex 'first'", 'cd ../old', "codex 'second'", 'cd ../current', "codex 'third'"].join(
            '\n'
          ),
          {},
          current
        )
        expect(result.code, result.stderr).toBe(0)
        expect(result.stdout.split('\n').filter((line) => line.startsWith('<'))).toEqual([
          '<--no-daemon><first>',
          '<second>',
          '<--no-daemon><third>'
        ])
      })

      it.each([
        { command: "codex 'hello world'", version: 'unknown', argv: '<hello world>' },
        {
          command: "codex resume 'session id'",
          version: '0.158.0',
          argv: '<--no-daemon><resume><session id>'
        },
        { command: 'codex fork session', version: '0.158.0', argv: '<--no-daemon><fork><session>' },
        { command: 'codex exec hello', version: '0.158.0', argv: '<exec><hello>' },
        { command: 'codex app-server', version: '0.158.0', argv: '<app-server>' },
        { command: 'codex --version', version: '0.158.0', argv: '' },
        { command: 'codex --no-daemon hello', version: '0.158.0', argv: '<--no-daemon><hello>' },
        // Codex refuses --no-daemon beside --remote, including after resume or a prompt.
        {
          command: 'codex resume --remote ws://127.0.0.1:1',
          version: '0.158.0',
          argv: '<resume><--remote><ws://127.0.0.1:1>'
        },
        {
          command: 'codex hello --remote=ws://127.0.0.1:1',
          version: '0.158.0',
          argv: '<hello><--remote=ws://127.0.0.1:1>'
        },
        {
          command: "codex -m model 'hello world'",
          version: '0.158.0',
          argv: '<--no-daemon><-m><model><hello world>'
        }
      ])(
        'preserves argv and exit status for $command with version=$version',
        async ({ command, version, argv }) => {
          const fixture = await sandbox()
          const result = await launch(spec, fixture, command, {
            TEST_CODEX_VERSION: version,
            TEST_EXIT_CODE: '23'
          })
          if (command === 'codex --version') {
            expect(result.code, result.stderr).toBe(0)
            expect(result.stdout).toBe(`codex-cli ${version}\n`)
            return
          }
          expect(result.code, result.stderr).toBe(23)
          expect(result.stdout.trim().split('\n').at(-1)).toBe(argv)
        }
      )
    }
  )
}
