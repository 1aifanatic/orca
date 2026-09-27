import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runProcess } from '../shared/child-process/run-process'

it.skipIf(!process.env.BUN_EXECUTABLE || process.platform === 'win32')(
  'hands the public bin to Bun through a symlink and preserves argv and exit code',
  async () => {
    const runtime = process.env.BUN_EXECUTABLE
    if (!runtime) {
      throw new Error('BUN_EXECUTABLE is required')
    }
    const root = await mkdtemp(join(tmpdir(), "orca bin '$ "))
    try {
      const cli = join(root, 'out', 'cli')
      const runtimeDirectory = join(
        root,
        'out',
        'cli-runtime',
        `${process.platform}-${process.arch}`
      )
      await mkdir(cli, { recursive: true })
      await mkdir(runtimeDirectory, { recursive: true })
      await copyFile(join(process.cwd(), 'out/cli/cli-bin.js'), join(cli, 'cli-bin.js'))
      await writeFile(
        join(cli, 'index.js'),
        'process.stdout.write(JSON.stringify({bun:process.versions.bun,args:process.argv.slice(2)}));process.exitCode=17'
      )
      const alias = join(root, 'alias.js')
      await symlink(join(cli, 'cli-bin.js'), alias)
      const missing = await runProcess({ program: process.execPath, args: [alias] })
      expect(missing.code).toBe(78)
      expect(missing.stdout).toBe('')
      await symlink(runtime, join(runtimeDirectory, 'bun-runtime'))
      const argv = ['two words', 'line\nbreak', '']
      const result = await runProcess({
        program: process.execPath,
        args: [alias, ...argv],
        cwd: tmpdir(),
        env: { ORCA_BACKGROUND_LAUNCH: '1' }
      })
      expect(result.code, result.stderr).toBe(17)
      expect(JSON.parse(result.stdout)).toEqual({ bun: expect.any(String), args: argv })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
