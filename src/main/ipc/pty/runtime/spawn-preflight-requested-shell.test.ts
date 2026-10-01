import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { getDefaultSettings } from '../../../../shared/constants'
import { finishPtyShutdown } from '../provider/liveness'
import { prepareRuntimePtySpawn } from './spawn-preflight'
import { buildRuntimePtySpawnOptions } from './spawn-options'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { ClaudeProfileRoutingService } from '../../../claude-accounts/claude-profile-routing-service'
import { createWslClaudeProfileOwner } from '../../../claude-accounts/claude-profile-wsl-owner'

const profiles = vi.hoisted(() => {
  const state: { authority?: ClaudeProfileRoutingService } = {}
  return state
})
vi.mock('../../../claude-accounts/claude-profile-routing-authority', () => ({
  getClaudeProfileRoutingAuthority: () => profiles.authority
}))

const HOST_DEFAULT_SHELL = 'powershell.exe'
const hostPlatform = process.platform

function makeDeps(): PtyRuntimeControllerDeps {
  const noCodexResumeLaunch: PtyRuntimeControllerDeps['noCodexResumeLaunch'] = (command) => ({
    codexResumeHome: null,
    command,
    notifyResumeUnavailable: false,
    droppedResumeArgv: false,
    providerSession: null
  })
  return {
    store: undefined,
    getSettings: () => ({
      ...getDefaultSettings('/tmp'),
      terminalWindowsShell: HOST_DEFAULT_SHELL
    }),
    adoptStablePane: async () => null,
    getLocalPtyStartupPromise: () => undefined,
    getLocalPtyProviderStartupPromise: () => undefined,
    prepareCodexResumeHome: () => null,
    resolveCodexResumeLaunch: async (command) => noCodexResumeLaunch(command),
    noCodexResumeLaunch,
    reconcileSharedRuntimeResumeHome: async (resumeHome) => resumeHome.codexHomePath,
    stripSequencedStartupResumeArgv: (env) => env,
    assertFolderWorkspacePtyPathUsable: () => undefined,
    resolvePtySpawnStartupCwd: (_worktreeId, cwd) => cwd,
    requestSerializedBuffer: async () => null,
    shutdownProviderAndDetectExit: async () => false,
    rememberSyntheticKillExit: () => {},
    rememberRetiredRejectedPty: () => {},
    sendPtyExitToRenderer: () => {},
    sendPtySpawnedToRenderer: () => {},
    finishPtyShutdown,
    trustedTerminalHandleEnv: new Set(),
    retiredRejectedPtyIds: new Map(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `operations.ts` (write/clearBuffer) reads `mainWindow`; the spawn preflight and option build never touch it, and a real BrowserWindow cannot exist in vitest.
    mainWindow: {} as BrowserWindow
  }
}

/** Runs the preflight and option build the way `spawnPtyFromRuntimeController` sequences them. */
async function resolveSpawnShell(shellOverride: string | undefined): Promise<string | undefined> {
  const args: RuntimePtySpawnArgs = { cols: 120, rows: 40, shellOverride }
  const ctx = createRuntimePtySpawnState(makeDeps(), args)
  await prepareRuntimePtySpawn(ctx)
  await buildRuntimePtySpawnOptions(ctx)
  ctx.finishTerminalInstall()
  return ctx.spawnOptions.shellOverride
}

/**
 * Behavioural twin of `pty-spawn-shell-override-parity.test.ts`: a local Windows runtime spawn
 * (`terminal create --shell`, headless serve) must hand the caller's shell to the provider, not
 * the host default with the request typed into it.
 */
describe('runtime pty spawn preflight: requested shell on a local Windows host', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  })

  it('spawns the requested shell as the pty', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    await expect(resolveSpawnShell('cmd.exe')).resolves.toBe('cmd.exe')
  })

  it('keeps the host default shell when nothing was requested', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    await expect(resolveSpawnShell(undefined)).resolves.toBe(HOST_DEFAULT_SHELL)
  })
})

describe('runtime pty spawn preflight: Claude profiles in a WSL pane', () => {
  afterEach(() => {
    profiles.authority = undefined
    Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  })

  it('opens a plain WSL pane on a stopped distro without asking the guest anything', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const prepareGuest = vi.fn(async (): Promise<never> => {
      throw new Error('WSL distro Ubuntu is not running')
    })
    profiles.authority = new ClaudeProfileRoutingService(
      createWslClaudeProfileOwner(
        () => ({
          ...getDefaultSettings('/tmp'),
          activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'a' } }
        }),
        prepareGuest,
        async () => {}
      )
    )
    const args: RuntimePtySpawnArgs = {
      cols: 120,
      rows: 40,
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\u',
      env: { KEEP: '1' }
    }
    const ctx = createRuntimePtySpawnState(makeDeps(), args)
    await expect(prepareRuntimePtySpawn(ctx)).resolves.toBeNull()
    expect(ctx.codexSelectionTarget).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(prepareGuest).not.toHaveBeenCalled()
    expect(args.env).toEqual({ KEEP: '1' })
  })
})
