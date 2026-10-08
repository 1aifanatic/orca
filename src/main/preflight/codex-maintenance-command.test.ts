import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexCliInstallation } from '../../shared/codex-cli-installation'
import { resolveCodexMaintenanceCommand } from './codex-maintenance-command'

const { invocation, installation, packages, lookup, resolve } = vi.hoisted(() => ({
  invocation: vi.fn(),
  installation: vi.fn(),
  packages: vi.fn(),
  lookup: vi.fn(),
  resolve: vi.fn()
}))
vi.mock('../codex/codex-structured-launch-resolution', () => ({
  resolveCodexStructuredInvocation: invocation
}))
vi.mock('./codex-cli-installation', () => ({
  readCodexCliInstallationEvidence: async (input: unknown) => ({
    installation: await installation(input),
    expiresAt: Date.now() + 30_000,
    configurationId: 'config'
  }),
  codexCliPackagePaths: packages
}))
vi.mock('../ipc/command-path-resolver', () => ({
  listLocalCommandPaths: lookup,
  resolveLocalExecutionCommand: async (program: string) => ({ status: 'resolved', program })
}))
vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveCliCommand: resolve,
  withCliRuntimeOnPath: (_program: string, env: NodeJS.ProcessEnv) => env
}))
vi.mock('../startup/login-shell-environment', () => ({ resolveLoginShellEnvironment: vi.fn() }))
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-source-'))
  invocation.mockResolvedValue({ command: join(root, 'codex'), environment: { PATH: root } })
  lookup.mockImplementation(async (command) => [command])
  packages.mockResolvedValue([join(root, 'package.json')])
  resolve.mockReturnValue(join(root, 'npm'))
  installation.mockResolvedValue(codexCliInstallation(true, '0.135.0'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('Codex maintenance command choice', () => {
  it('updates a resolved native binary with that binary, without a shell', async () => {
    const result = await resolveCodexMaintenanceCommand()
    expect(result.action?.command).toBe('codex update')
    expect(result.spec).toMatchObject({
      program: join(root, 'codex'),
      env: { PATH: root },
      args: ['update']
    })
  })
  it('uses the npm install when the resolved launcher belongs to the Codex npm package', async () => {
    const packageDir = join(root, 'lib', 'node_modules', '@openai', 'codex')
    await mkdir(packageDir, { recursive: true })
    const packageFile = join(packageDir, 'package.json')
    await writeFile(packageFile, JSON.stringify({ name: '@openai/codex' }))
    packages.mockResolvedValue([packageFile])
    const result = await resolveCodexMaintenanceCommand()
    expect(result.action?.command).toBe('npm install -g @openai/codex')
    expect(result.spec?.args).toEqual(['install', '-g', '@openai/codex', '--prefix', root])
    expect(result.spec?.program).toBe(join(root, 'npm'))
  })
  it('does not mistake an unrelated package for a Codex npm installation', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'another-package' }))
    expect((await resolveCodexMaintenanceCommand()).action?.command).toBe('codex update')
  })
  it('chooses npm for a missing Codex installation', async () => {
    installation.mockResolvedValue(codexCliInstallation(false, null))
    const result = await resolveCodexMaintenanceCommand()
    expect(result.action?.kind).toBe('install')
    expect(result.spec?.args).toEqual(['install', '-g', '@openai/codex'])
  })
  it.each([null, '0.136.0'])(
    'withholds actions for unknown and supported versions: %s',
    async (version) => {
      installation.mockResolvedValue(codexCliInstallation(true, version))
      expect((await resolveCodexMaintenanceCommand()).spec).toBeNull()
    }
  )
  it('resolves npm.cmd on Windows for the shared spawn runner', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      installation.mockResolvedValue(codexCliInstallation(false, null))
      const result = await resolveCodexMaintenanceCommand()
      expect(result.spec?.program).toBe(join(root, 'npm.cmd'))
      expect(result.spec?.args).toEqual(['install', '-g', '@openai/codex'])
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })
})
