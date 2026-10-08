import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { orcadPosixCliLauncher } from './orcad-cli-package.mjs'

it.skipIf(process.platform === 'win32')(
  'uses the slot runtime and preserves multiline CLI arguments',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'orcad cli launcher '))
    try {
      const slot = join(root, 'slot')
      const launcher = join(slot, 'bin', 'orca')
      const runtime = join(root, 'runtimes', `node-${'a'.repeat(64)}`, 'bin', 'node')
      mkdirSync(dirname(launcher), { recursive: true })
      mkdirSync(dirname(runtime), { recursive: true })
      symlinkSync(process.execPath, runtime)
      writeFileSync(join(slot, '.runtime-node'), `${'a'.repeat(64)}\n`)
      writeFileSync(launcher, orcadPosixCliLauncher())
      chmodSync(launcher, 0o755)
      writeFileSync(
        join(slot, 'orca-cli.js'),
        `console.log(JSON.stringify({argv: process.argv.slice(2), runtime: process.execPath, profile: process.env.ORCA_USER_DATA_PATH, options: process.env.NODE_OPTIONS ?? null, owningHost: process.env.ORCA_CLI_OWNING_HOST}))`
      )
      const body = 'paragraph one\n\nparagraph two "$variable" `literal`'
      const env = {
        PATH: '/usr/bin:/bin',
        ORCA_USER_DATA_PATH: root,
        NODE_OPTIONS: '--no-warnings'
      }
      const child = spawnSync(launcher, ['orchestration', 'send', '--body', body], {
        env,
        encoding: 'utf8'
      })
      expect(child.status, child.stderr).toBe(0)
      expect(JSON.parse(child.stdout)).toEqual({
        argv: ['orchestration', 'send', '--body', body],
        runtime: process.execPath,
        profile: root,
        options: null,
        owningHost: '1'
      })
      const unbound = spawnSync(launcher, ['status', '--json'], {
        env: { PATH: env.PATH },
        encoding: 'utf8'
      })
      expect(unbound.status).not.toBe(0)
      expect(unbound.stderr).toContain('server data path is required')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
