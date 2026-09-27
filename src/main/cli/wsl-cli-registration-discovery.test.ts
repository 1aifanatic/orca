import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { WslCliInstaller } from './wsl-cli-installer'
import { getWslLauncherMarker } from './wsl-cli-scripts'
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

type GuestScript = {
  /** Guest command stdout, or an Error to throw, for the command-file read at the wrapper path. */
  commandFile?: string
  failHome?: boolean
  failInstall?: boolean
  hostStatus?: () => Promise<CliInstallStatus>
}

/** Every guest command the installer runs is one `wsl.exe -d <distro>` spawn in production. */
function countingInstaller(script: GuestScript = {}): {
  createInstaller: (distro: string) => WslCliInstaller
  wslSpawns: () => number
  hostProbes: () => number
} {
  let spawns = 0
  let hostProbes = 0
  const wslRunner = async (_distro: string, command: string): Promise<string> => {
    spawns += 1
    if (command === 'printf %s "$HOME"') {
      if (script.failHome) {
        throw new Error('WSL command timed out after 10000ms.')
      }
      return '/home/user'
    }
    if (command.includes('command -v wslpath')) {
      return 'yes'
    }
    if (command.includes('case ":$PATH:"')) {
      return 'yes'
    }
    if (command.includes('__ORCA_MISSING__')) {
      return command.includes('/.local/bin/orca-ide') && script.commandFile
        ? script.commandFile
        : '__ORCA_MISSING__'
    }
    if (script.failInstall) {
      throw new Error('mv: Read-only file system')
    }
    return ''
  }
  return {
    createInstaller: (distro) =>
      new WslCliInstaller({
        platform: 'win32',
        distro,
        hostInstaller: {
          getStatus: async () => {
            hostProbes += 1
            return (script.hostStatus ?? (async () => hostStatus()))()
          }
        },
        wslRunner
      }),
    wslSpawns: () => spawns,
    hostProbes: () => hostProbes
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

  it('stamps a guest probe failure so the next launch does not re-probe it', async () => {
    const installer = countingInstaller({ failHome: true })

    const [first] = await reconcile(installer.createInstaller, ['Ubuntu'])
    const firstLaunch = installer.wslSpawns()
    await reconcile(installer.createInstaller, ['Ubuntu'])

    expect(first).toMatchObject({ outcome: 'failed' })
    expect(firstLaunch).toBe(1)
    expect(installer.wslSpawns()).toBe(firstLaunch)
  })

  it('skips discovery without stamping when the host launcher target is unknown', async () => {
    const installer = countingInstaller()

    await expect(
      reconcileManagedWslCliRegistrations({
        platform: 'win32',
        isPackaged: true,
        userDataPath,
        appVersion: '1.4.212',
        listDistros: async () => ['Ubuntu'],
        listRunningDistros: async () => ['Ubuntu'],
        getHostLauncherTarget: async () => null,
        createInstaller: installer.createInstaller
      })
    ).resolves.toEqual([])
    expect(installer.wslSpawns()).toBe(0)

    await reconcile(installer.createInstaller, ['Ubuntu'])
    expect(installer.wslSpawns()).toBeGreaterThan(0)
  })

  it('does not stamp a host launcher failure inside repair as a distro failure', async () => {
    const installer = countingInstaller({
      hostStatus: async () => {
        throw new Error('powershell probe timed out')
      }
    })

    await reconcile(installer.createInstaller, ['Ubuntu'])
    await reconcile(installer.createInstaller, ['Ubuntu'])

    expect(installer.hostProbes()).toBe(2)
  })

  it('retries an Orca-managed wrapper whose repair install failed on the next launch', async () => {
    const staleWrapper = `#!/usr/bin/env sh\n# ${getWslLauncherMarker()}\nexec 'C:\\Old\\orca.exe' "$@"\n`
    const installer = countingInstaller({ commandFile: staleWrapper, failInstall: true })

    const [first] = await reconcile(installer.createInstaller, ['Ubuntu'])
    const firstLaunch = installer.wslSpawns()
    const [second] = await reconcile(installer.createInstaller, ['Ubuntu'])

    expect(first).toMatchObject({ outcome: 'failed', error: 'mv: Read-only file system' })
    expect(second).toMatchObject({ outcome: 'failed' })
    expect(installer.wslSpawns()).toBe(firstLaunch * 2)
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
