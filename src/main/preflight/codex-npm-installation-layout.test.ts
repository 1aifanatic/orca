import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { invalidateCodexCliInstallation } from './codex-cli-installation'
import { resolveCodexMaintenanceCommand } from './codex-maintenance-command'
import { readCodexNpmInstallationLayout } from './codex-npm-installation-layout'

vi.mock('../startup/login-shell-environment', () => ({
  resolveLoginShellEnvironment: async () => ({})
}))

let root: string
afterEach(async () => {
  invalidateCodexCliInstallation()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

async function packageAt(directory: string) {
  await mkdir(join(directory, 'bin'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@openai/codex' }))
  const program = join(directory, 'bin', 'codex.js')
  await writeFile(program, `#!${process.execPath}\nconsole.log('codex-cli 0.135.0')\n`, {
    mode: 0o755
  })
  return program
}

describe.skipIf(process.platform === 'win32')('POSIX npm installation repair', () => {
  it.each(['direct', 'linked'] as const)(
    'names a selected local package for manual repair (%s)',
    async (selection) => {
      root = await mkdtemp(join(tmpdir(), 'codex-local-package-'))
      const packageRoot = join(root, 'node_modules', '@openai', 'codex')
      const target = await packageAt(packageRoot)
      const link = join(root, 'node_modules', '.bin', 'codex')
      await mkdir(dirname(link))
      await symlink(target, link)
      const program = selection === 'linked' ? link : target
      const result = await resolveCodexMaintenanceCommand({
        cwd: root,
        commandSettings: { agentCmdOverrides: { codex: program } }
      })
      const canonical = await realpath(packageRoot)
      expect(result.installation.status).toBe('unsupported')
      expect(result.spec).toBeNull()
      expect(result.action).toEqual({
        kind: 'update',
        manual: true,
        installationPath: canonical,
        command: `Install or update Codex at ${canonical} to 0.136.0 or newer, then try again.`
      })
    }
  )

  it('repairs the verified global package at the same prefix for a link or direct launcher', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-global-package-'))
    const target = await packageAt(join(root, 'lib', 'node_modules', '@openai', 'codex'))
    const link = join(root, 'bin', 'codex')
    await mkdir(dirname(link))
    await symlink(target, link)
    for (const program of [target, link]) {
      const result = await resolveCodexMaintenanceCommand({
        cwd: root,
        commandSettings: { agentCmdOverrides: { codex: program } }
      })
      expect(result.action?.manual).toBeUndefined()
      expect(result.spec?.args).toEqual([
        'install',
        '-g',
        '@openai/codex',
        '--prefix',
        await realpath(root)
      ])
    }
  })

  it('requires the global launcher to select this package, even in a global-shaped directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-unverified-prefix-'))
    const target = await packageAt(join(root, 'lib', 'node_modules', '@openai', 'codex'))
    await mkdir(join(root, 'bin'))
    await writeFile(join(root, 'bin', 'codex'), 'unrelated launcher', { mode: 0o755 })
    const result = await resolveCodexMaintenanceCommand({
      commandSettings: { agentCmdOverrides: { codex: target } }
    })
    expect(result.action?.manual).toBe(true)
    expect(result.spec).toBeNull()
  })

  it('preserves package-manager ownership when a global link points into a virtual store', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-managed-package-'))
    const modules = join(root, 'lib', 'node_modules')
    const packageRoot = join(modules, '.pnpm', 'codex@0.135.0', 'node_modules', '@openai', 'codex')
    const target = await packageAt(packageRoot)
    const alias = join(modules, '@openai', 'codex')
    await mkdir(dirname(alias), { recursive: true })
    await symlink(packageRoot, alias)
    await mkdir(join(root, 'bin'))
    const program = join(root, 'bin', 'codex')
    await symlink(target, program)
    const result = await resolveCodexMaintenanceCommand({
      commandSettings: { agentCmdOverrides: { codex: program } }
    })
    expect(result.action?.installationPath).toBe(await realpath(packageRoot))
    expect(result.action?.manual).toBe(true)
    expect(result.spec).toBeNull()
  })
})

it('distinguishes the Windows global prefix launcher from a local .bin shim', async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-windows-layout-'))
  const packageRoot = join(root, 'node_modules', '@openai', 'codex')
  await packageAt(packageRoot)
  const global = join(root, 'codex.cmd')
  const local = join(root, 'node_modules', '.bin', 'codex.cmd')
  await mkdir(dirname(local))
  await Promise.all([writeFile(global, 'global shim'), writeFile(local, 'local shim')])
  const packages = [join(packageRoot, 'package.json')]
  expect(await readCodexNpmInstallationLayout(packages, global, 'win32')).toMatchObject({
    kind: 'global',
    prefix: await realpath(root)
  })
  expect(await readCodexNpmInstallationLayout(packages, local, 'win32')).toMatchObject({
    kind: 'managed'
  })
})
