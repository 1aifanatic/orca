import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSequencedSetupAgentCommands } from './setup-agent-sequencing'

// Why: the POSIX gate evals the agent in a fresh `bash -lc`, which never reads
// Orca's shell wrapper, so it must carry the codex --no-daemon rule itself.
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function runGate(startupCommand: string, help: string, env: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-gate-codex-'))
  roots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const codex = join(bin, 'codex')
  writeFileSync(
    codex,
    `#!/bin/sh\n[ "$1" = --help ] && { printf '%s\\n' '${help}'; exit 0; }\nprintf 'ARGV:%s\\n' "$*"\n`
  )
  chmodSync(codex, 0o755)
  const runner = join(root, 'setup-runner.sh')
  const sequenced = createSequencedSetupAgentCommands({
    runnerScriptPath: runner,
    startupCommand,
    platform: 'posix',
    nonce: 'n1'
  })
  writeFileSync(`${runner}.n1.done`, 'n1:0\n')
  const result = spawnSync('bash', ['-c', sequenced.startupCommand], {
    encoding: 'utf8',
    // Why HOME and PATH: `bash -l` must read no real profile and resolve only the fake codex.
    env: { HOME: root, PATH: `${bin}:/usr/bin:/bin`, ...sequenced.startupEnv, ...env }
  })
  return result.stdout
}

describe.skipIf(process.platform === 'win32')('sequenced setup gate runs codex', () => {
  it('with --no-daemon when the binary supports it', () => {
    expect(runGate('codex --yolo', '--no-daemon')).toBe('ARGV:--no-daemon --yolo\n')
  })

  it.each([
    ['an old binary', 'codex --yolo', '--no-alt-screen', {}],
    ['a subcommand that needs the shared server', 'codex agents', '--no-daemon', {}],
    ['the opt-out', 'codex --yolo', '--no-daemon', { ORCA_CODEX_ISOLATE: '0' }]
  ])('unchanged for %s', (_case, command, help, env) => {
    expect(runGate(command, help, env)).toBe(`ARGV:${command.slice('codex '.length)}\n`)
  })
})
