import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalPtyLaunchPlan, resolveLocalPtyWslDistro } from './local-pty-launch-plan'
import type { LocalPtyProviderOptions } from './local-pty-provider-types'
import type { PtySpawnOptions } from './types'
import { resolveWslLaunchDirectory } from './wsl-launch-directory-resolution'
import type * as WslModule from '../wsl'

const { runWslProcess } = vi.hoisted(() => ({ runWslProcess: vi.fn() }))
vi.mock('../wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof WslModule>()),
  getDefaultWslDistro: () => 'Debian'
}))
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess }))
vi.mock('./local-pty-utils', () => ({
  ensureNodePtySpawnHelperExecutable: vi.fn(),
  validateWorkingDirectory: vi.fn()
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  vi.clearAllMocks()
})

function answers(stdout: string, code = 0) {
  return { environmentResolved: true, code, stdout, stderr: '', timedOut: false }
}

describe('resolveWslLaunchDirectory', () => {
  it("names a cache directory in the distro's home both ways, with the pane's login shell", async () => {
    runWslProcess.mockResolvedValue(answers('/home/ada\n/usr/bin/zsh\n'))
    await expect(resolveWslLaunchDirectory('Ubuntu')).resolves.toEqual({
      distro: 'Ubuntu',
      windowsPath: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.cache\\orca',
      linuxPath: '/home/ada/.cache/orca',
      shell: '/usr/bin/zsh'
    })
    expect(runWslProcess).toHaveBeenCalledWith(
      expect.objectContaining({ distro: 'Ubuntu', loginPath: 'none', shell: 'sh' })
    )
  })

  // Why: files written over the UNC share take 9P's default mode, so only the directory's mode
  // keeps a worker brief from the distro's other users.
  it('makes the cache directory private to the distro user before anything is written there', async () => {
    runWslProcess.mockResolvedValue(answers('/home/ada\n/bin/bash\n'))
    await resolveWslLaunchDirectory('Kali')
    expect(runWslProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        script: expect.stringContaining(
          `_orca_root="$HOME"/'.cache/orca'\nmkdir -p "$_orca_root" && chmod 700 "$_orca_root" || exit 1`
        )
      })
    )
  })

  it('probes a distro once, and asks again only after a failure', async () => {
    runWslProcess.mockResolvedValueOnce(answers('', 1))
    await expect(resolveWslLaunchDirectory('Arch')).resolves.toBeUndefined()
    runWslProcess.mockResolvedValue(answers('/home/ada\n/bin/bash\n'))
    await expect(resolveWslLaunchDirectory('Arch')).resolves.toMatchObject({ shell: '/bin/bash' })
    await resolveWslLaunchDirectory('Arch')
    expect(runWslProcess).toHaveBeenCalledTimes(2)
  })

  it('has none for a spawn outside WSL or a distro whose home cannot be read', async () => {
    await expect(resolveWslLaunchDirectory(undefined)).resolves.toBeUndefined()
    runWslProcess.mockResolvedValue(answers('not-a-path\n'))
    await expect(resolveWslLaunchDirectory('Alpine')).resolves.toBeUndefined()
    runWslProcess.mockRejectedValue(new Error('wsl.exe missing'))
    await expect(resolveWslLaunchDirectory('Fedora')).resolves.toBeUndefined()
  })
})

describe('resolveLocalPtyWslDistro', () => {
  // Why: the launch file goes into this distro, so it must be the one the plan starts.
  it.each<[string, Partial<PtySpawnOptions>, string]>([
    ['a WSL worktree path', { cwd: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\repo' }, 'Ubuntu'],
    [
      'a WSL worktree id',
      { cwd: 'C:\\work', worktreeId: 'repo::\\\\wsl.localhost\\Arch\\home\\ada\\repo' },
      'Arch'
    ],
    [
      'a WSL tab with a chosen distro',
      { cwd: 'C:\\work', shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Alpine' },
      'Alpine'
    ],
    ['a WSL tab on the default distro', { cwd: 'C:\\work', shellOverride: 'wsl.exe' }, 'Debian'],
    ['WSL as the default shell', { cwd: 'C:\\work' }, 'Debian']
  ])('agrees with the launch plan for %s', (_label, spawn, distro) => {
    const args = { cols: 80, rows: 24, ...spawn }
    const getOptions = (): LocalPtyProviderOptions => ({ getWindowsShell: () => 'wsl.exe' })
    expect(resolveLocalPtyWslDistro(args, getOptions)).toBe(distro)
    const plan = createLocalPtyLaunchPlan(args, getOptions)
    expect('launchWslDistro' in plan && plan.launchWslDistro).toBe(distro)
  })

  it('has none for a PowerShell tab', () => {
    const getOptions = (): LocalPtyProviderOptions => ({ getWindowsShell: () => 'powershell.exe' })
    expect(resolveLocalPtyWslDistro({ cols: 80, rows: 24, cwd: 'C:\\work' }, getOptions)).toBe(
      undefined
    )
  })
})
