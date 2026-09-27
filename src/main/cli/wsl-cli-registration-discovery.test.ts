import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { WslCliInstaller } from './wsl-cli-installer'
import { reconcileManagedWslCliRegistrations } from './wsl-cli-registration-reconciliation'
import { recordWslCliRegistrationInstalled } from './wsl-cli-registration-registry'

const LAUNCHER = 'C:\\Orca\\resources\\bin\\orca.exe'

function hostStatus(): CliInstallStatus {
  return {
    platform: 'win32',
    commandName: 'orca',
    commandPath: 'C:\\Orca\\bin\\orca.cmd',
    pathDirectory: 'C:\\Orca\\bin',
    pathConfigured: true,
    launcherPath: LAUNCHER,
    installMethod: 'wrapper',
    supported: true,
    state: 'installed',
    currentTarget: LAUNCHER,
    unsupportedReason: null,
    detail: null
  }
}

/** Every guest command the installer runs is one `wsl.exe -d <distro>` spawn in production. */
function countingInstaller(): {
  createInstaller: (distro: string) => WslCliInstaller
  wslSpawns: () => number
} {
  let spawns = 0
  const wslRunner = async (_distro: string, command: string): Promise<string> => {
    spawns += 1
    if (command === 'printf %s "$HOME"') {
      return '/home/user'
    }
    if (command.includes('command -v wslpath')) {
      return 'yes'
    }
    if (command.includes('case ":$PATH:"')) {
      return 'yes'
    }
    return '__ORCA_MISSING__'
  }
  return {
    createInstaller: (distro) =>
      new WslCliInstaller({
        platform: 'win32',
        distro,
        hostInstaller: { getStatus: async () => hostStatus() },
        wslRunner
      }),
    wslSpawns: () => spawns
  }
}

describe('WSL CLI registration discovery on a host that never registered the CLI', () => {
  let userDataPath: string

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'orca-wsl-cli-discovery-'))
  })

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true })
  })

  const reconcile = (
    createInstaller: NonNullable<
      Parameters<typeof reconcileManagedWslCliRegistrations>[0]['createInstaller']
    >,
    running: string[]
  ): ReturnType<typeof reconcileManagedWslCliRegistrations> =>
    reconcileManagedWslCliRegistrations({
      platform: 'win32',
      isPackaged: true,
      userDataPath,
      appVersion: '1.4.212',
      listDistros: async () => ['Ubuntu'],
      listRunningDistros: async () => running,
      getHostLauncherTarget: async () => LAUNCHER,
      createInstaller
    })

  it('does not spawn wsl -d against a stopped distro it only wants to discover', async () => {
    const installer = countingInstaller()

    const results = await reconcile(installer.createInstaller, [])

    expect(installer.wslSpawns()).toBe(0)
    expect(results).toEqual([])
  })

  it('stamps a failed discovery so the next launch does not re-probe it', async () => {
    const repair = vi.fn(async () => {
      throw new Error('WSL command timed out after 10000ms.')
    })
    const createInstaller = (): { repairManagedRegistration: typeof repair } => ({
      repairManagedRegistration: repair
    })

    await reconcile(createInstaller, ['Ubuntu'])
    await reconcile(createInstaller, ['Ubuntu'])

    expect(repair).toHaveBeenCalledTimes(1)
  })

  it('still repairs a distro the user registered even when it is stopped', async () => {
    await recordWslCliRegistrationInstalled(userDataPath, 'Ubuntu')
    const installer = countingInstaller()

    const results = await reconcile(installer.createInstaller, [])

    expect(results).toEqual([
      { distro: 'Ubuntu', outcome: 'unchanged', state: 'not_installed', managed: false }
    ])
    expect(installer.wslSpawns()).toBeGreaterThan(0)
  })

  it('still discovers a running distro once, then leaves it alone', async () => {
    const installer = countingInstaller()

    await reconcile(installer.createInstaller, ['ubuntu'])
    const firstLaunch = installer.wslSpawns()
    await reconcile(installer.createInstaller, ['ubuntu'])

    expect(firstLaunch).toBeGreaterThan(0)
    expect(installer.wslSpawns()).toBe(firstLaunch)
  })
})
